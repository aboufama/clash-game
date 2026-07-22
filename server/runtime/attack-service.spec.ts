import assert from 'node:assert/strict'
import test from 'node:test'
import { ApiError } from '../errors'
import { LIVE_REPLAY_SPECTATOR_GRACE_MS } from '../../src/game/replay/ReplayTypes'
import {
  MemoryPersistence,
  type AccountRecord,
  type Persistence,
  type UnitOfWork,
  type VillageRecord
} from '../persistence'
import {
  BOT_RAID_COOLDOWN_MS,
  MAX_BOT_RAID_COOLDOWNS,
  MAX_REVENGE_OPPONENTS,
  MAX_REVENGE_RIGHTS_PER_OPPONENT,
  REVENGE_RIGHT_TTL_MS
} from '../domain/attack-retention'
import {
  MAX_PRESENTATION_REPLAY_BYTES,
  MAX_PRESENTATION_REPLAY_V2_BYTES,
  PRESENTATION_REPLAY_RETENTION_MS,
  createPersistenceAttackService,
  type PersistenceAttackServiceOptions
} from './attack-service'

const START = new Date('2026-01-01T00:00:00.000Z')

class OccupancyCountingPersistence implements Persistence {
  readonly base = new MemoryPersistence()
  pointQueries = 0
  batchQueries = 0

  transaction<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T> {
    return this.base.transaction(tx => work(new Proxy(tx, {
      get: (target, property, receiver) => {
        if (property !== 'world') return Reflect.get(target, property, receiver) as unknown
        return new Proxy(target.world, {
          get: (world, method, worldReceiver) => {
            const value = Reflect.get(world, method, worldReceiver) as unknown
            if (method === 'getOccupant' && typeof value === 'function') {
              return (...args: unknown[]) => {
                this.pointQueries += 1
                return Reflect.apply(value, world, args) as unknown
              }
            }
            if (method === 'listOccupantsAt' && typeof value === 'function') {
              return (...args: unknown[]) => {
                this.batchQueries += 1
                return Reflect.apply(value, world, args) as unknown
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

function account(id: string, patch: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id,
    username: id,
    usernameKey: id,
    passwordHash: null,
    registered: true,
    trophies: 100,
    shieldUntil: null,
    createdAt: START,
    lastSeenAt: START,
    revision: 0,
    revengeRights: {},
    botRaidCooldowns: {},
    testModeAcknowledgedActivationId: null,
    introBattleCompleted: true,
    ...patch
  }
}

function village(playerId: string, army: Record<string, number> = { warrior: 2 }): VillageRecord {
  return {
    playerId,
    buildings: [
      { id: `town-hall-${playerId}`, type: 'town_hall', level: 1, gridX: 10, gridY: 10 },
      { id: `watchtower-${playerId}`, type: 'watchtower', level: 1, gridX: 2, gridY: 2 }
    ],
    obstacles: [],
    army,
    wallLevel: 1,
    gold: playerId.startsWith('defender') ? 10_000 : 0,
    ore: playerId.startsWith('defender') ? 100 : 0,
    food: playerId.startsWith('defender') ? 100 : 0,
    productionRemainders: { ore: 0, food: 0 },
    population: { count: 3, lastGrowthAt: START.getTime(), bornAt: [] },
    banner: null,
    simulatedThrough: START,
    lastMutationAt: START,
    layoutRevision: 1,
    appearanceRevision: 1,
    economyRevision: 0,
    simulationVersion: 2,
    nextEventAt: null
  }
}

async function fixture(
  ids: readonly string[] = ['attacker', 'defender'],
  persistence: Persistence = new MemoryPersistence(),
  options: PersistenceAttackServiceOptions = {}
): Promise<{
  persistence: Persistence
  now: { value: Date }
  service: ReturnType<typeof createPersistenceAttackService>
}> {
  await persistence.transaction(async tx => {
    await tx.world.ensureRegion({
      worldId: 'main',
      regionId: 'main:r0:0:0:g1',
      regionX: 0,
      regionY: 0,
      size: 32,
      generationVersion: 1,
      createdAt: START
    })
    let x = 0
    for (const id of ids) {
      await tx.accounts.insert(account(id))
      await tx.villages.insert(village(id))
      await tx.world.assign({
        worldId: 'main',
        x,
        y: 0,
        regionId: 'main:r0:0:0:g1',
        playerId: id,
        plotVersion: 1,
        assignedAt: START,
        leaseId: null,
        leaseIssuedAt: null,
        leaseRenewedAt: null,
        leaseExpiresAt: null
      })
      x += 1
    }
  })
  const now = { value: new Date(START) }
  let nextId = 0
  const service = createPersistenceAttackService(persistence, {
    ...options,
    now: () => new Date(now.value),
    createId: prefix => `${prefix}_test_${++nextId}`
  })
  return { persistence, now, service }
}

function deploy(attackId: string, sequence = 1) {
  return {
    attackId,
    commands: [{
      type: 'DEPLOY',
      commandId: `deploy_${sequence}`,
      sequence,
      troopInstanceId: `troop_${sequence}`,
      troopType: 'warrior',
      gridX: 0,
      gridY: 0
    }]
  }
}

async function villageOf(persistence: Persistence, playerId: string): Promise<VillageRecord> {
  const record = await persistence.transaction(tx => tx.villages.get(playerId))
  assert.ok(record)
  return record
}

async function patchAccount(
  persistence: Persistence,
  playerId: string,
  patch: (record: AccountRecord) => void
): Promise<void> {
  await persistence.transaction(async tx => {
    const record = await tx.accounts.getById(playerId)
    assert.ok(record)
    const expectedRevision = record.revision
    patch(record)
    record.revision += 1
    assert.equal(await tx.accounts.update(record, expectedRevision), true)
  })
}

async function patchVillage(
  persistence: Persistence,
  playerId: string,
  patch: (record: VillageRecord) => void
): Promise<void> {
  await persistence.transaction(async tx => {
    const record = await tx.villages.get(playerId)
    assert.ok(record)
    const expectedRevision = record.economyRevision
    patch(record)
    record.economyRevision += 1
    assert.equal(await tx.villages.update(record, expectedRevision), true)
  })
}

test('attack materialization preserves authoritative ore and food above storage capacity', async () => {
  const { persistence, now, service } = await fixture()
  const attackerResources = { ore: 100_021, food: 1_000_009 }
  const defenderResources = { ore: 200_021, food: 2_000_009 }
  await patchVillage(persistence, 'attacker', record => Object.assign(record, attackerResources))
  await patchVillage(persistence, 'defender', record => Object.assign(record, defenderResources))

  now.value = new Date(START.getTime() + 60_000)
  await service.startAttack({ playerId: 'attacker' }, {
    targetId: 'defender', requestId: 'start-over-cap-authority'
  }, false, 'device-token')

  const attacker = await villageOf(persistence, 'attacker')
  const defender = await villageOf(persistence, 'defender')
  assert.deepEqual({ ore: attacker.ore, food: attacker.food }, attackerResources)
  assert.deepEqual({ ore: defender.ore, food: defender.food }, defenderResources)
})

test('player attacks reserve once, fence on first deploy, command exactly once, and settle from deterministic authority', async () => {
  const { persistence, now, service } = await fixture(['attacker', 'defender', 'outsider'])
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-player-1'
  }, false, 'device-token')
  const retry = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-player-1'
  }, false, 'device-token')
  assert.deepEqual(retry, started)
  assert.deepEqual(started.reservedArmy, { warrior: 2 },
    'the start response carries the immutable reservation after the village army is cleared')
  assert.deepEqual((await villageOf(persistence, 'attacker')).army, {})
  assert.equal((await villageOf(persistence, 'attacker')).economyRevision, 1)
  assert.equal((await villageOf(persistence, 'defender')).economyRevision, 0)
  assert.equal((await service.activeOutgoingBattle(principal, 'device-token')).session?.ownedByCurrentSession, true)
  assert.deepEqual(await service.incomingAttacks({ playerId: 'defender' }), [])

  now.value = new Date(START.getTime() + 1_000)
  const accepted = await service.pushCommands(principal, deploy(started.attackId))
  assert.equal(accepted.phase, 'ACTIVE')
  const duplicate = await service.pushCommands(principal, deploy(started.attackId))
  assert.equal(duplicate.receipts[0]?.duplicate, true)
  assert.equal((await service.incomingAttacks({ playerId: 'defender' })).length, 1)
  await assert.rejects(service.pushCommands(principal, deploy(started.attackId, 3)), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'COMMAND_SEQUENCE_GAP')
    return true
  })

  await service.pushFrames(principal, {
    attackId: started.attackId,
    frames: [{
      t: 1_000,
      destruction: 100,
      goldLooted: 999_999_999,
      buildings: [],
      troops: []
    }]
  })
  now.value = new Date(START.getTime() + 61_000)
  const settled = await service.endAttack(principal, {
    attackId: started.attackId,
    status: 'finished',
    destruction: 100,
    goldLooted: 999_999_999
  })
  assert.ok(settled.lootApplied <= started.lootCap)
  assert.notEqual(settled.lootApplied, 999_999_999)
  assert.equal(settled.army.warrior, 1)
  const settlementRetry = await service.endAttack(principal, {
    attackId: started.attackId,
    status: 'finished',
    destruction: 0,
    goldLooted: 0
  })
  assert.equal(settlementRetry.lootApplied, settled.lootApplied)

  const attack = await persistence.transaction(tx => tx.attacks.get(started.attackId))
  assert.equal(attack?.authority?.phase, 'SETTLED')
  assert.equal(attack?.authority?.reservation.deployed.warrior, 1)
  const notifications = await persistence.transaction(tx => tx.notifications.listForPlayer({
    playerId: 'defender', limit: 10
  }))
  assert.equal(notifications.length, 1)
  const defender = await persistence.transaction(tx => tx.accounts.getById('defender'))
  assert.deepEqual(defender?.revengeRights.attacker, {
    count: 1,
    expiresAt: now.value.getTime() + REVENGE_RIGHT_TTL_MS
  })
  const replay = await service.getReplay(principal, started.attackId)
  assert.ok(replay.enemyWorld)
  assert.equal(Array.isArray(replay.frames), true)
  now.value = new Date(now.value.getTime() + LIVE_REPLAY_SPECTATOR_GRACE_MS + 1)
  await assert.rejects(service.getReplay({ playerId: 'outsider' }, started.attackId), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 403)
    return true
  })
  const outbox = await persistence.transaction(tx => tx.outbox.claimBatch(
    'test-worker', now.value, new Date(now.value.getTime() + 60_000), 100
  ))
  assert.ok(outbox.some(event => event.eventType === 'attack.settled'))
})

test('Watchtower-visible neighbors can stream only live scrubbed replay data', async () => {
  const { persistence, now, service } = await fixture([
    'spectator',
    'sight-filler',
    'defender',
    'attacker',
    'outsider'
  ])
  const attacker = { playerId: 'attacker' }
  const spectator = { playerId: 'spectator' }
  const defender = { playerId: 'defender' }
  await patchVillage(persistence, 'spectator', record => {
    const tower = (record.buildings as unknown as Array<Record<string, unknown>>)
      .find(building => building.type === 'watchtower')
    assert(tower)
    tower.upgradingTo = 2
    tower.upgradeStartedAt = START.getTime()
    tower.upgradeEndsAt = START.getTime() + 500
  })
  const started = await service.startAttack(attacker, {
    targetId: 'defender', requestId: 'start-neighbor-stream'
  }, false, 'device-token')

  await assert.rejects(service.getReplay(spectator, started.attackId), error => (
    error instanceof ApiError && error.status === 403
  ), 'a prepared selection is not yet a visible live battle')

  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(attacker, deploy(started.attackId))
  const frame = {
    t: 1_000,
    destruction: 10,
    goldLooted: 321,
    oreLooted: 22,
    foodLooted: 11,
    buildings: [{ id: 'town-hall-defender', health: 900, isDestroyed: false }],
    troops: [{
      id: 'troop_1', type: 'warrior', level: 1, owner: 'PLAYER' as const,
      gridX: 2, gridY: 2, health: 75, maxHealth: 100
    }]
  }
  await service.pushFrames(attacker, {
    attackId: started.attackId,
    frames: [frame],
    replayV2: {
      chunks: [{ kind: 'keyframe', sequence: 1, t: 1_000, frame }]
    }
  })

  const participantReplay = await service.getReplay(defender, started.attackId) as {
    enemyWorld: { resources: { gold: number; ore: number; food: number } }
    frames: Array<{ goldLooted: number; oreLooted: number; foodLooted: number }>
  }
  assert.ok(participantReplay.enemyWorld.resources.gold > 0)
  assert.ok((participantReplay.frames[0]?.goldLooted ?? 0) > 0)

  const spectatorReplay = await service.getReplay(spectator, started.attackId) as {
    enemyWorld: { resources: { gold: number; ore: number; food: number } }
    frames: Array<{ goldLooted: number; oreLooted: number; foodLooted: number }>
    v2Chunks: Array<{
      kind: string
      frame?: { goldLooted: number; oreLooted: number; foodLooted: number }
    }>
    finalResult?: unknown
  }
  const unmaterializedSpectator = await persistence.transaction(tx => tx.villages.get('spectator'))
  assert.equal(
    (unmaterializedSpectator?.buildings as unknown as Array<Record<string, unknown>> | undefined)
      ?.some(building => building.type === 'watchtower'
        && building.level === 1 && building.upgradingTo === 2),
    true,
    'read-only replay authorization observes a completed upgrade without materializing it'
  )
  assert.deepEqual(spectatorReplay.enemyWorld.resources, { gold: 0, ore: 0, food: 0 })
  assert.deepEqual(
    spectatorReplay.frames.map(item => [item.goldLooted, item.oreLooted, item.foodLooted]),
    [[0, 0, 0]]
  )
  assert.deepEqual(
    spectatorReplay.v2Chunks.map(item => item.frame
      ? [item.frame.goldLooted, item.frame.oreLooted, item.frame.foodLooted]
      : null),
    [[0, 0, 0]]
  )
  assert.equal(spectatorReplay.finalResult, undefined)

  const incremental = await service.getReplay(spectator, started.attackId, undefined, 0) as {
    enemyWorld?: unknown
    frames: Array<{ goldLooted: number; oreLooted: number; foodLooted: number }>
    v2Chunks: Array<{ kind: string; frame?: { goldLooted: number } }>
  }
  assert.equal(incremental.enemyWorld, undefined)
  assert.deepEqual(incremental.frames, [])
  assert.equal(incremental.v2Chunks[0]?.frame?.goldLooted, 0)

  await assert.rejects(service.getReplay({ playerId: 'outsider' }, started.attackId), error => (
    error instanceof ApiError && error.status === 403
  ), 'a village outside the current Watchtower horizon cannot guess a stream id')

  await patchVillage(persistence, 'spectator', record => {
    record.buildings = record.buildings.filter(building => (
      !building || typeof building !== 'object' || Array.isArray(building)
        || building.type !== 'watchtower'
    ))
  })
  await assert.rejects(service.getReplay(spectator, started.attackId), error => (
    error instanceof ApiError && error.status === 403
  ), 'authorization is re-evaluated from the viewer current village on every poll')

  await patchVillage(persistence, 'spectator', record => {
    record.buildings.push({
      id: 'watchtower-spectator-restored', type: 'watchtower', level: 2, gridX: 2, gridY: 2
    })
  })
  now.value = new Date(START.getTime() + 2_000)
  await service.endAttack(attacker, { attackId: started.attackId, status: 'aborted' })
  const terminalGraceReplay = await service.getReplay(spectator, started.attackId) as {
    status: string
    finalResult?: unknown
    frames: Array<{ goldLooted: number }>
  }
  assert.notEqual(terminalGraceReplay.status, 'live')
  assert.equal(terminalGraceReplay.finalResult, undefined)
  assert.equal(terminalGraceReplay.frames[0]?.goldLooted, 0,
    'terminal drain grace keeps the same spectator economy scrubbing')

  now.value = new Date(START.getTime() + 2_000 + LIVE_REPLAY_SPECTATOR_GRACE_MS + 1)
  await assert.rejects(service.getReplay(spectator, started.attackId), error => (
    error instanceof ApiError && error.status === 403
  ), 'neighbor capability ends immediately after the bounded terminal drain grace')
})

test('expired revenge rights cannot pierce a shield at selection or first engagement', async () => {
  {
    const { persistence, service } = await fixture()
    await patchAccount(persistence, 'attacker', record => {
      record.revengeRights = { defender: { count: 3, expiresAt: START.getTime() } }
    })
    await patchAccount(persistence, 'defender', record => {
      record.shieldUntil = new Date(START.getTime() + 60 * 60_000)
    })
    await assert.rejects(service.startAttack({ playerId: 'attacker' }, {
      targetId: 'defender', requestId: 'expired-before-selection'
    }, false, 'device-token'), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'TARGET_SHIELDED')
      return true
    })
    assert.deepEqual((await villageOf(persistence, 'attacker')).army, { warrior: 2 })
  }

  {
    const { persistence, now, service } = await fixture()
    await patchAccount(persistence, 'attacker', record => {
      record.revengeRights = { defender: { count: 1, expiresAt: START.getTime() + 500 } }
    })
    await patchAccount(persistence, 'defender', record => {
      record.shieldUntil = new Date(START.getTime() + 60 * 60_000)
    })
    const started = await service.startAttack({ playerId: 'attacker' }, {
      targetId: 'defender', requestId: 'expires-before-engagement'
    }, false, 'device-token')
    now.value = new Date(START.getTime() + 1_000)
    await assert.rejects(service.pushCommands({ playerId: 'attacker' }, deploy(started.attackId)), error => {
      assert.ok(error instanceof ApiError)
      assert.equal(error.code, 'TARGET_SHIELDED')
      return true
    })
    assert.deepEqual((await villageOf(persistence, 'attacker')).army, { warrior: 2 })
    assert.equal((await persistence.transaction(tx => tx.attacks.get(started.attackId)))?.authority?.phase, 'CANCELLED')
  }
})

test('matchmake finds the other player in a two-player world and soft exclusion never empties it', async () => {
  const { service } = await fixture(['attacker', 'defender'])
  const principal = { playerId: 'attacker' }

  const first = await service.matchmake(principal, { requestId: 'two-player-first' }, 'device-token')
  assert.equal(first.world.ownerId, 'defender')
  assert.deepEqual(first.reservedArmy, { warrior: 2 })
  await service.endAttack(principal, { attackId: first.attackId, status: 'aborted' })

  // Soft repeat-avoidance (excludeTargetId) reuses the sole candidate rather
  // than making a one-opponent world unplayable.
  const reused = await service.matchmake(principal, {
    requestId: 'two-player-soft', excludeTargetId: 'defender'
  }, 'device-token')
  assert.equal(reused.world.ownerId, 'defender')
  await service.endAttack(principal, { attackId: reused.attackId, status: 'aborted' })

  // Strict NEXT exclusions exhaust the pool with a distinct code, so the
  // client can transition to bot camps.
  await assert.rejects(service.matchmake(principal, {
    requestId: 'two-player-exhausted', excludeTargetIds: ['defender']
  }, 'device-token'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    assert.equal(error.code, 'MATCH_POOL_EXHAUSTED')
    return true
  })
})

test('NEXT cycling visits every eligible player once before reporting exhaustion', async () => {
  const { service } = await fixture(['attacker', 'defender_one', 'defender_two', 'defender_three'])
  const principal = { playerId: 'attacker' }
  const seen: string[] = []
  for (let step = 0; step < 3; step += 1) {
    const started = await service.matchmake(principal, {
      requestId: `cycle-${step}`,
      ...(seen.length > 0 ? { excludeTargetIds: [...seen] } : {})
    }, 'device-token')
    const ownerId = started.world.ownerId
    assert.ok(!seen.includes(ownerId), 'a base excluded this session is never re-offered')
    seen.push(ownerId)
    await service.endAttack(principal, { attackId: started.attackId, status: 'aborted' })
  }
  assert.deepEqual([...seen].sort(), ['defender_one', 'defender_three', 'defender_two'])
  await assert.rejects(service.matchmake(principal, {
    requestId: 'cycle-exhausted', excludeTargetIds: seen
  }, 'device-token'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'MATCH_POOL_EXHAUSTED')
    return true
  })
})

test('matchmake keeps principled exclusions: shielded players are invisible to the pool', async () => {
  const { persistence, service } = await fixture(['attacker', 'defender'])
  await patchAccount(persistence, 'defender', record => {
    record.shieldUntil = new Date(START.getTime() + 60 * 60_000)
  })
  await assert.rejects(service.matchmake({ playerId: 'attacker' }, {
    requestId: 'all-shielded'
  }, 'device-token'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 404)
    assert.equal(error.code, 'NO_OPPONENTS')
    return true
  })
  await assert.rejects(service.matchmake({ playerId: 'attacker' }, {
    requestId: 'oversized-exclusions',
    excludeTargetIds: Array.from({ length: 65 }, (_, index) => `p_${index}`)
  }, 'device-token'), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.status, 400)
    return true
  })
})

test('legacy revenge values canonicalize and settlements cap counts and opponents', async () => {
  const { persistence, now, service } = await fixture()
  const grantedAt = START.getTime() - 1_000
  await patchAccount(persistence, 'attacker', record => {
    record.revengeRights = {
      defender: { count: 2, grantedAt },
      numeric_legacy: 99,
      expired_legacy: { count: 3, grantedAt: START.getTime() - REVENGE_RIGHT_TTL_MS - 1 }
    }
  })
  await patchAccount(persistence, 'defender', record => {
    record.shieldUntil = new Date(START.getTime() + 60 * 60_000)
  })

  const prepared = await service.startAttack({ playerId: 'attacker' }, {
    targetId: 'defender', requestId: 'canonical-revenge-1'
  }, false, 'device-token')
  const canonical = await persistence.transaction(async tx => ({
    account: await tx.accounts.getById('attacker'),
    attack: await tx.attacks.get(prepared.attackId)
  }))
  assert.deepEqual(canonical.account?.revengeRights.defender, {
    count: 1,
    expiresAt: grantedAt + REVENGE_RIGHT_TTL_MS
  })
  assert.deepEqual(canonical.account?.revengeRights.numeric_legacy, {
    count: MAX_REVENGE_RIGHTS_PER_OPPONENT,
    expiresAt: START.getTime() + REVENGE_RIGHT_TTL_MS
  })
  assert.equal(canonical.account?.revengeRights.expired_legacy, undefined)
  assert.equal(canonical.attack?.authority?.target.kind === 'PLAYER'
    ? canonical.attack.authority.target.shieldBypassExpiresAt
    : undefined, grantedAt + REVENGE_RIGHT_TTL_MS)
  await service.endAttack({ playerId: 'attacker' }, { attackId: prepared.attackId, status: 'aborted' })

  await patchAccount(persistence, 'defender', record => {
    record.shieldUntil = null
    record.revengeRights = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [
      index === 0 ? 'attacker' : `opponent_${index}`,
      { count: 99, expiresAt: START.getTime() + REVENGE_RIGHT_TTL_MS - index }
    ]))
  })
  const fought = await service.startAttack({ playerId: 'attacker' }, {
    targetId: 'defender', requestId: 'canonical-revenge-2'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands({ playerId: 'attacker' }, deploy(fought.attackId))
  now.value = new Date(START.getTime() + 61_000)
  await service.endAttack({ playerId: 'attacker' }, { attackId: fought.attackId, status: 'finished' })

  const rights = (await persistence.transaction(tx => tx.accounts.getById('defender')))?.revengeRights ?? {}
  assert.equal(Object.keys(rights).length, MAX_REVENGE_OPPONENTS)
  assert.deepEqual(rights.attacker, {
    count: MAX_REVENGE_RIGHTS_PER_OPPONENT,
    expiresAt: now.value.getTime() + REVENGE_RIGHT_TTL_MS
  })
  for (const value of Object.values(rights)) {
    assert.deepEqual(Object.keys(value as object).sort(), ['count', 'expiresAt'])
    assert.ok(Number((value as { count: number }).count) <= MAX_REVENGE_RIGHTS_PER_OPPONENT)
  }
})

test('changed appearance invalidates a prepared target and atomically returns the reservation', async () => {
  const { persistence, now, service } = await fixture()
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-fence-1'
  }, false, 'device-token')
  await persistence.transaction(async tx => {
    const defender = await tx.villages.get('defender')
    assert.ok(defender)
    const expected = defender.economyRevision
    defender.appearanceRevision += 1
    defender.layoutRevision += 1
    defender.economyRevision += 1
    assert.equal(await tx.villages.update(defender, expected), true)
  })
  now.value = new Date(START.getTime() + 1_000)
  await assert.rejects(service.pushCommands(principal, deploy(started.attackId)), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'TARGET_VERSION_CHANGED')
    return true
  })
  assert.deepEqual((await villageOf(persistence, 'attacker')).army, { warrior: 2 })
  assert.equal((await service.activeOutgoingBattle(principal, 'device-token')).session, null)
  assert.equal((await persistence.transaction(tx => tx.attacks.get(started.attackId)))?.authority?.phase, 'CANCELLED')
})

test('bot raids use the same command aggregate, retry safely, and ignore client settlement claims', async () => {
  const { persistence, now, service } = await fixture(['attacker'])
  // Simulation v3 attrition: a lone warrior dies to the camp's defenses in
  // seconds and banks ~nothing, so this ledger-wiring test also fields a
  // golem that survives long enough to produce a real settlement delta.
  await persistence.transaction(async tx => {
    const record = await tx.villages.get('attacker', { forUpdate: true })
    assert.ok(record)
    const expectedRevision = record.economyRevision
    record.army = { warrior: 2, golem: 1 }
    record.economyRevision = expectedRevision + 1
    assert.equal(await tx.villages.update(record, expectedRevision), true)
  })
  const principal = { playerId: 'attacker' }
  const started = await service.botStart(principal, { requestId: 'start-bot-1' }, 'device-token')
  assert.deepEqual(started.reservedArmy, { warrior: 2, golem: 1 })
  assert.deepEqual(await service.botStart(principal, { requestId: 'start-bot-1' }, 'device-token'), started)
  now.value = new Date(START.getTime() + 1_000)
  const command = await service.pushCommands(principal, deploy(started.raidId))
  assert.equal(command.raidId, started.raidId)
  now.value = new Date(START.getTime() + 2_000)
  await service.pushCommands(principal, {
    attackId: started.raidId,
    commands: [{
      type: 'DEPLOY',
      commandId: 'deploy_2',
      sequence: 2,
      troopInstanceId: 'troop_2',
      troopType: 'golem',
      gridX: 0,
      gridY: 0
    }]
  })
  now.value = new Date(START.getTime() + 61_000)
  const settled = await service.botSettle(principal, {
    raidId: started.raidId,
    x: started.x,
    y: started.y,
    requestId: 'settle-bot-1',
    destruction: 100,
    deployed: { warrior: 2 }
  })
  assert.equal(settled.army.warrior, 1)
  assert.ok(settled.lootApplied < 999_999_999)
  assert.deepEqual(await service.botSettle(principal, {
    raidId: started.raidId,
    x: started.x,
    y: started.y,
    requestId: 'settle-bot-1',
    destruction: 0,
    deployed: {}
  }), settled)
  const stored = await persistence.transaction(async tx => ({
    attack: await tx.attacks.get(started.raidId),
    account: await tx.accounts.getById('attacker'),
    bot: await tx.world.getBotVillageAt('main', started.x, started.y)
  }))
  assert.equal(stored.attack?.authority?.target.kind, 'BOT')
  assert.equal(stored.attack?.authority?.phase, 'SETTLED')
  assert.equal(stored.bot?.id, stored.attack?.targetId,
    'the attack and settlement retain one persisted bot authority record')
  assert.equal(typeof stored.account?.botRaidCooldowns[`${started.x},${started.y}`], 'number')
  const day = Math.floor(now.value.getTime() / 86_400_000)
  const ledger = await persistence.transaction(tx => tx.balanceLedger.summarizeDays(day, day))
  assert.equal(ledger.some(row => row.operation === 'bot-attack-settlement'), settled.lootApplied > 0,
    'zero-loot hard bases emit no balance delta; positive bot loot uses the bot ledger operation')
  assert.equal(ledger.some(row => row.operation === 'attack-settlement'), false)
})

test('random bot discovery batches occupancy into one bounded repository query', async () => {
  const persistence = new OccupancyCountingPersistence()
  const { service } = await fixture(['attacker'], persistence)
  const principal = { playerId: 'attacker' }
  const started = await service.botStart(principal, { requestId: 'batched-bot-probe' }, 'device-token')
  assert.equal(typeof started.seed, 'number')
  assert.equal(persistence.pointQueries, 0)
  assert.equal(persistence.batchQueries, 1)
  assert.deepEqual(
    await service.botStart(principal, { requestId: 'batched-bot-probe' }, 'device-token'),
    started
  )
  assert.equal(persistence.batchQueries, 1, 'idempotent retry does not probe occupancy again')
})

test('cloud bot discovery rejects unbounded or malformed rotation exclusions', async () => {
  const { service } = await fixture(['attacker'])
  await assert.rejects(
    service.botStart(
      { playerId: 'attacker' },
      { requestId: 'too-many-exclusions', excludeCampKeys: Array.from({ length: 65 }, (_, i) => `${i},0`) },
      'device-token'
    ),
    error => error instanceof ApiError && error.status === 400
  )
  await assert.rejects(
    service.botStart(
      { playerId: 'attacker' },
      { requestId: 'malformed-exclusion', excludeCampKeys: ['not-a-coordinate'] },
      'device-token'
    ),
    error => error instanceof ApiError && error.status === 400
  )
})

test('bot cooldown storage prunes expired coordinates and stays bounded after settlement', async () => {
  const { persistence, now, service } = await fixture(['attacker'])
  await patchAccount(persistence, 'attacker', record => {
    record.botRaidCooldowns = {
      ...Object.fromEntries(Array.from({ length: MAX_BOT_RAID_COOLDOWNS + 40 }, (_, index) => [
        `${10_000 + index},${20_000 + index}`,
        START.getTime() - index
      ])),
      ...Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
        `${30_000 + index},${40_000 + index}`,
        START.getTime() - BOT_RAID_COOLDOWN_MS - index
      ])),
      malformed: START.getTime()
    }
  })

  const principal = { playerId: 'attacker' }
  const started = await service.botStart(principal, { requestId: 'bounded-bot-start' }, 'device-token')
  const afterStart = (await persistence.transaction(tx => tx.accounts.getById('attacker')))?.botRaidCooldowns ?? {}
  assert.equal(Object.keys(afterStart).length, MAX_BOT_RAID_COOLDOWNS)
  assert.equal(afterStart['30000,40000'], undefined)
  assert.equal(afterStart.malformed, undefined)

  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(principal, deploy(started.raidId))
  now.value = new Date(START.getTime() + 61_000)
  await service.botSettle(principal, {
    raidId: started.raidId,
    x: started.x,
    y: started.y,
    requestId: 'bounded-bot-settle'
  })
  const settled = (await persistence.transaction(tx => tx.accounts.getById('attacker')))?.botRaidCooldowns ?? {}
  assert.equal(Object.keys(settled).length, MAX_BOT_RAID_COOLDOWNS)
  assert.equal(settled[`${started.x},${started.y}`], now.value.getTime())
  assert.ok(Object.values(settled).every(value => Number(value) > now.value.getTime() - BOT_RAID_COOLDOWN_MS))
})

test('prepared attacks expire without participant activity and release every reserved troop', async () => {
  const { persistence, now, service } = await fixture()
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-expiry-1'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 11 * 60_000)
  assert.deepEqual(await service.sweepDueAttacks(10), { processed: 1, settled: 0, expired: 1 })
  assert.equal((await service.activeOutgoingBattle(principal, 'device-token')).session, null)
  assert.deepEqual((await villageOf(persistence, 'attacker')).army, { warrior: 2 })
  assert.equal((await persistence.transaction(tx => tx.attacks.get(started.attackId)))?.authority?.phase, 'EXPIRED')
})

test('maintenance deterministically settles an abandoned active attack', async () => {
  const { persistence, now, service } = await fixture()
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-active-expiry-1'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(principal, deploy(started.attackId))
  now.value = new Date(START.getTime() + 16 * 60_000)
  assert.deepEqual(await service.sweepDueAttacks(10), { processed: 1, settled: 1, expired: 0 })
  const attack = await persistence.transaction(tx => tx.attacks.get(started.attackId))
  assert.equal(attack?.authority?.phase, 'SETTLED')
  assert.equal((await villageOf(persistence, 'attacker')).army.warrior, 1)
})

test('replay-v2 is contiguous, ordered, retry-safe, and same-bucket v1 corrections replace stale health', async () => {
  const { now, service } = await fixture()
  const attacker = { playerId: 'attacker' }
  const defender = { playerId: 'defender' }
  const started = await service.startAttack(attacker, {
    targetId: 'defender', requestId: 'start-replay-v2-order'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(attacker, deploy(started.attackId))

  const frame = (t: number, health: number, ballistaAngle: number) => ({
    t,
    destruction: health <= 0 ? 100 : 0,
    goldLooted: 0,
    buildings: [{ id: 'town-hall-defender', health, isDestroyed: health <= 0, ballistaAngle }],
    troops: []
  })
  const receipt = await service.pushFrames(attacker, {
    attackId: started.attackId,
    frames: [frame(100, 1_000, 0.25), frame(105, 700, 1.25)],
    replayV2: {
      chunks: [{
        kind: 'event', sequence: 1, t: 400,
        event: {
          version: 1, id: 'impact-1', seed: 101, type: 'projectile.impact',
          payload: { projectileId: 'projectile-1', targetId: 'town-hall-defender' }
        }
      }, {
        kind: 'event', sequence: 2, t: 400,
        event: {
          version: 1, id: 'damage-1', seed: 102, type: 'combat.damage',
          payload: { sourceId: 'troop_1', targetId: 'town-hall-defender', amount: 300, healthAfter: 700 }
        }
      }, {
        kind: 'keyframe', sequence: 3, t: 1_000, frame: frame(1_000, 700, 1.25)
      }]
    }
  })
  assert.deepEqual(receipt, {
    frameCount: 1,
    acceptedFrames: 1,
    replacedFrames: 1,
    duplicateFrames: 0,
    droppedFrames: 0,
    acceptedV2: 3,
    duplicateV2: 0,
    droppedV2: 0,
    lastV2Sequence: 3,
    terminalOnlyV2: false
  })

  const full = await service.getReplay(defender, started.attackId) as {
    frames: Array<{ t: number; buildings: Array<{ health: number; ballistaAngle?: number }> }>
    v2Chunks: Array<{ sequence: number; kind: string }>
    lastV2Sequence: number
  }
  assert.equal(full.frames.length, 1)
  assert.equal(full.frames[0]?.t, 105)
  assert.equal(full.frames[0]?.buildings[0]?.health, 700)
  assert.equal(full.frames[0]?.buildings[0]?.ballistaAngle, 1.25)
  assert.deepEqual(full.v2Chunks.map(chunk => chunk.sequence), [1, 2, 3])
  assert.equal(full.lastV2Sequence, 3)

  const retry = await service.pushFrames(attacker, {
    attackId: started.attackId,
    replayV2: {
      chunks: [{
        kind: 'event', sequence: 2, t: 400,
        event: {
          version: 1, id: 'damage-1', seed: 102, type: 'combat.damage',
          payload: { sourceId: 'troop_1', targetId: 'town-hall-defender', amount: 300, healthAfter: 700 }
        }
      }, {
        kind: 'keyframe', sequence: 3, t: 1_000, frame: frame(1_000, 700, 1.25)
      }]
    }
  })
  assert.equal(retry.duplicateV2, 2)
  assert.equal(retry.lastV2Sequence, 3)

  const incremental = await service.getReplay(defender, started.attackId, 400, 1) as {
    enemyWorld?: unknown
    v2Chunks: Array<{ sequence: number }>
  }
  assert.equal(incremental.enemyWorld, undefined)
  assert.deepEqual(incremental.v2Chunks.map(chunk => chunk.sequence), [2, 3])

  await assert.rejects(service.pushFrames(attacker, {
    attackId: started.attackId,
    replayV2: {
      chunks: [{
        kind: 'event', sequence: 5, t: 1_100,
        event: {
          version: 1, id: 'gap-5', seed: 105, type: 'combat.attack',
          payload: { actorId: 'troop_1', phase: 'release' }
        }
      }]
    }
  }), error => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'REPLAY_SEQUENCE_GAP')
    return true
  })
})

test('complete saved replay returns more than the former 260-frame tail', async () => {
  const { now, service } = await fixture()
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-complete-replay'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(principal, deploy(started.attackId))

  for (let offset = 0; offset < 304; offset += 16) {
    await service.pushFrames(principal, {
      attackId: started.attackId,
      frames: Array.from({ length: Math.min(16, 304 - offset) }, (_, index) => ({
        t: (offset + index) * 2_000,
        destruction: 0,
        goldLooted: 0,
        buildings: [{ id: 'town-hall-defender', health: 1_000, isDestroyed: false }],
        troops: []
      }))
    })
  }
  const replay = await service.getReplay({ playerId: 'defender' }, started.attackId) as {
    frames: Array<{ t: number }>
  }
  assert.equal(replay.frames.length, 304)
  assert.equal(replay.frames[0]?.t, 0)
  assert.equal(replay.frames[303]?.t, 606_000)
})

test('default replay-v2 budget accepts a stream larger than the legacy 2 MiB frame budget', async () => {
  assert.ok(MAX_PRESENTATION_REPLAY_V2_BYTES >= 64 * 1024 * 1024)
  const { now, service } = await fixture()
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-replay-v2-large-default'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(principal, deploy(started.attackId))

  const chunks = Array.from({ length: 40 }, (_, index) => ({
    kind: 'event',
    sequence: index + 1,
    t: index * 10,
    event: {
      version: 1,
      id: `large-default-${index + 1}`,
      seed: index + 1,
      type: 'fx',
      payload: { data: 'x'.repeat(60_000), index }
    }
  }))
  assert.ok(Buffer.byteLength(JSON.stringify(chunks), 'utf8') > MAX_PRESENTATION_REPLAY_BYTES)
  const receipt = await service.pushFrames(principal, {
    attackId: started.attackId,
    replayV2: { chunks }
  })
  assert.equal(receipt.acceptedV2, chunks.length)
  assert.equal(receipt.droppedV2, 0)
  assert.equal(receipt.lastV2Sequence, chunks.length)
  assert.equal(receipt.terminalOnlyV2, false)
})

test('v2 has a practical budget and accepts a terminal correction gap after an earlier reported drop', async () => {
  assert.ok(MAX_PRESENTATION_REPLAY_V2_BYTES >= 64 * 1024 * 1024)
  const { now, service } = await fixture(undefined, undefined, {
    maxPresentationReplayV2Bytes: 75_000
  })
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-replay-v2-terminal'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(principal, deploy(started.attackId))

  const largeEvent = (sequence: number) => ({
    kind: 'event',
    sequence,
    t: sequence * 100,
    event: {
      version: 1,
      id: `large-event-${sequence}`,
      seed: sequence,
      type: 'fx',
      payload: { data: 'x'.repeat(60_000), sequence }
    }
  })
  const dropped = await service.pushFrames(principal, {
    attackId: started.attackId,
    replayV2: { chunks: [largeEvent(1), largeEvent(2), largeEvent(3)] }
  })
  assert.equal(dropped.acceptedV2, 1)
  assert.equal(dropped.droppedV2, 2)
  assert.equal(dropped.lastV2Sequence, 1)
  assert.equal(dropped.terminalOnlyV2, true)

  const terminal = await service.pushFrames(principal, {
    attackId: started.attackId,
    replayV2: {
      chunks: [{
        kind: 'keyframe', sequence: 4, t: 400, terminal: true,
        frame: {
          t: 400,
          destruction: 100,
          goldLooted: 0,
          buildings: [{ id: 'town-hall-defender', health: 0, isDestroyed: true }],
          troops: []
        }
      }]
    }
  })
  assert.equal(terminal.acceptedV2, 1)
  assert.equal(terminal.lastV2Sequence, 4)
  assert.equal(terminal.terminalOnlyV2, true)

  const replay = await service.getReplay({ playerId: 'defender' }, started.attackId) as {
    v2Chunks: Array<{ sequence: number; kind: string; terminal?: boolean }>
    terminalOnlyV2: boolean
  }
  assert.deepEqual(replay.v2Chunks.map(chunk => chunk.sequence), [1, 4])
  assert.equal(replay.v2Chunks.at(-1)?.sequence, 4)
  assert.equal(replay.v2Chunks.at(-1)?.kind, 'keyframe')
  assert.equal(replay.v2Chunks.at(-1)?.terminal, true)
  assert.equal(replay.terminalOnlyV2, true)
})

test('presentation replay bytes are atomically capped and old visual chunks expire without deleting authority', async () => {
  const { persistence, now, service } = await fixture()
  const principal = { playerId: 'attacker' }
  const started = await service.startAttack(principal, {
    targetId: 'defender', requestId: 'start-replay-budget-1'
  }, false, 'device-token')
  now.value = new Date(START.getTime() + 1_000)
  await service.pushCommands(principal, deploy(started.attackId))

  const troops = Array.from({ length: 1_000 }, (_, index) => ({
    id: `visual_${index}`,
    type: 'warrior',
    level: 1,
    owner: 'PLAYER',
    gridX: index % 25,
    gridY: Math.floor(index / 25) % 25,
    health: 100,
    maxHealth: 100
  }))
  for (let batch = 0; batch < 2; batch += 1) {
    await service.pushFrames(principal, {
      attackId: started.attackId,
      frames: Array.from({ length: 16 }, (_, index) => ({
        t: (batch * 16 + index) * 2_000,
        destruction: 0,
        goldLooted: 0,
        buildings: [],
        troops
      }))
    })
  }
  // A single malicious visual sample beyond the codec limit is simply dropped.
  await service.pushFrames(principal, {
    attackId: started.attackId,
    frames: [{
      t: 70_000,
      destruction: 100,
      goldLooted: 999_999_999,
      buildings: [],
      troops: troops.map((troop, index) => ({
        ...troop,
        id: `v${index}_${'x'.repeat(100)}`,
        type: 'w'.repeat(70)
      }))
    }]
  })

  const frames = await persistence.transaction(tx => tx.replays.listForParticipant({
    attackId: started.attackId,
    participantId: 'attacker',
    afterSequence: 0,
    limit: 128
  }))
  const visuals = frames.filter(frame => frame.format === 'presentation-frame-v1')
  const storedBytes = visuals.reduce((sum, frame) => sum + Buffer.byteLength(JSON.stringify(frame.payload), 'utf8'), 0)
  assert.ok(visuals.length > 0 && visuals.length < 32)
  assert.ok(storedBytes <= MAX_PRESENTATION_REPLAY_BYTES)

  now.value = new Date(START.getTime() + 61_000)
  await service.endAttack(principal, { attackId: started.attackId, status: 'finished' })
  now.value = new Date(START.getTime() + 61_000 + PRESENTATION_REPLAY_RETENTION_MS + 1)
  await service.sweepDueAttacks(10)
  const replay = await service.getReplay(principal, started.attackId)
  assert.deepEqual(replay.frames, [])
  assert.ok(replay.enemyWorld)
  assert.ok(replay.finalResult)
  assert.equal((await persistence.transaction(tx => tx.attacks.get(started.attackId)))?.authority?.phase, 'SETTLED')
})
