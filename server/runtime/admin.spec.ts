import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryPersistence, type AccountRecord, type VillageRecord } from '../persistence'
import { VILLAGE_SIMULATION_VERSION } from '../domain/village'
import { PersistenceGameService } from './service'

const NOW = new Date('2026-07-19T18:00:00.000Z')

function account(): AccountRecord {
  return {
    id: 'player_admin_test',
    username: 'OriginalChief',
    usernameKey: 'originalchief',
    passwordHash: 'scrypt:must-never-leave-admin-read-model',
    registered: true,
    trophies: 100,
    shieldUntil: new Date(NOW.getTime() + 60_000),
    createdAt: new Date(NOW.getTime() - 86_400_000),
    lastSeenAt: NOW,
    revision: 1,
    revengeRights: {},
    botRaidCooldowns: {}
  }
}

function village(): VillageRecord {
  return {
    playerId: 'player_admin_test',
    buildings: [],
    obstacles: [],
    army: { warrior: 3 },
    wallLevel: 1,
    gold: 500,
    ore: 200,
    food: 100,
    productionRemainders: { ore: 0, food: 0 },
    population: { count: 5 },
    banner: null,
    simulatedThrough: NOW,
    lastMutationAt: NOW,
    layoutRevision: 1,
    appearanceRevision: 1,
    economyRevision: 1,
    simulationVersion: VILLAGE_SIMULATION_VERSION,
    nextEventAt: null
  }
}

test('normalized admin service keeps reads bounded/secret-free and audits every mutation', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account())
    await tx.villages.insert(village())
    await tx.sessions.insert({
      tokenHash: 'a'.repeat(64),
      playerId: 'player_admin_test',
      createdAt: NOW,
      lastUsedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 86_400_000),
      deviceId: 'admin-spec'
    })
  })
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })

  const overview = await service.adminOverview()
  assert.equal(overview.players.total, 1)
  assert.equal(overview.players.online, 1)
  assert.equal(overview.economy.gold, 500)

  const players = await service.adminPlayers('original', 1)
  assert.equal(players.length, 1)
  assert.equal(JSON.stringify(players).includes('scrypt'), false)
  const detail = await service.adminPlayer('player_admin_test')
  assert.deepEqual(detail.resources, { gold: 500, ore: 200, food: 100 })
  assert.equal(detail.activeSessions, 1)
  assert.deepEqual(detail.army, { warrior: 3 })
  assert.deepEqual(detail.village, {
    id: 'world_player_admin_test',
    ownerId: 'player_admin_test',
    username: 'OriginalChief',
    buildings: [],
    obstacles: [],
    wallLevel: 1,
    lastSaveTime: NOW.getTime(),
    revision: 1,
    life: {
      version: 1,
      identity: 'player_admin_test',
      population: 5,
      bornAt: [],
      simulatedThrough: NOW.getTime()
    },
    stoneMaturity: 1
  })
  assert.equal(JSON.stringify(detail).includes('tokenHash'), false)
  assert.equal(JSON.stringify(detail.village).includes('gold'), false)

  await service.adminPlayerAction('player_admin_test', {
    type: 'adjust_resources', gold: 250, ore: -50, reason: 'support correction'
  })
  await service.adminPlayerAction('player_admin_test', {
    type: 'set_trophies', trophies: 777, reason: 'event award'
  })
  await service.adminPlayerAction('player_admin_test', {
    type: 'rename', username: 'RenamedChief', reason: 'requested rename'
  })
  await service.adminPlayerAction('player_admin_test', {
    type: 'send_notice', title: 'Server notice', message: 'Welcome back', severity: 'warning', reason: 'support message'
  })
  const suspension = await service.adminPlayerAction('player_admin_test', {
    type: 'set_access', state: 'suspended', until: NOW.getTime() + 60_000, reason: 'investigation'
  })
  assert.equal(suspension.changed, true)

  const updated = await service.adminPlayer('player_admin_test')
  assert.deepEqual(updated.resources, { gold: 750, ore: 150, food: 100 })
  assert.equal(updated.trophies, 777)
  assert.equal(updated.username, 'RenamedChief')
  assert.equal(updated.access, 'suspended')
  assert.equal(updated.activeSessions, 0, 'restricting access revokes every session')

  const notices = await persistence.transaction(tx => tx.notifications.listForPlayer({
    playerId: 'player_admin_test', limit: 10
  }))
  assert.equal(notices[0]?.eventType, 'admin_notice')
  assert.deepEqual(notices[0]?.payload, {
    kind: 'admin_notice', title: 'Server notice', message: 'Welcome back', severity: 'warning'
  })

  await service.adminOperation({
    type: 'set_maintenance', enabled: true, message: 'Deploying an update', reason: 'release'
  })
  const config = await service.adminConfig()
  assert.equal(config.maintenance.enabled, true)
  assert.equal(config.maintenance.message, 'Deploying an update')
  const audit = await service.adminAudit(20)
  assert.equal(audit.length, 6)
  assert.equal(audit.every(entry => entry.actor === 'admin'), true)
  assert.equal(JSON.stringify(audit).includes('scrypt'), false)
  assert.equal(JSON.stringify(audit).includes('tokenHash'), false)

  const economy = await service.adminEconomy(1)
  assert.equal(economy.days.length, 1)
  assert.ok(economy.days[0]!.faucets.gold >= 250)

  await assert.rejects(service.adminPlayers('', 101), /limit/i)
  await assert.rejects(service.adminBots({}, 128, 1), /radius/i)
  await assert.rejects(service.adminAudit(251), /limit/i)
  await service.close()
})

test('normalized admin player detail reports a missing authoritative village as null', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(tx => tx.accounts.insert(account()))
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })

  const detail = await service.adminPlayer('player_admin_test')
  assert.equal(detail.village, null)
  assert.equal(detail.buildingCount, 0)
  assert.equal(detail.obstacleCount, 0)

  await service.close()
})

test('normalized admin player detail materializes a read-only current village preview', async () => {
  const persistence = new MemoryPersistence()
  const pending = village()
  pending.buildings = [
    { id: 'hall', type: 'town_hall', gridX: 0, gridY: 0, level: 1 },
    {
      id: 'cannon', type: 'cannon', gridX: 4, gridY: 4, level: 1,
      upgradingTo: 2,
      upgradeStartedAt: NOW.getTime() - 2_000,
      upgradeEndsAt: NOW.getTime() - 1_000
    }
  ]
  pending.simulatedThrough = new Date(NOW.getTime() - 2_000)
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account())
    await tx.villages.insert(pending)
  })
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })

  const detail = await service.adminPlayer('player_admin_test')
  const cannon = detail.village?.buildings.find(building => building.id === 'cannon')
  assert.equal(cannon?.level, 2)
  assert.equal(cannon?.upgradingTo, undefined)
  assert.equal(detail.buildingCount, 2)

  const persisted = await persistence.transaction(tx => tx.villages.get('player_admin_test'))
  const persistedCannon = persisted?.buildings.find(building => (
    typeof building === 'object' && building !== null && !Array.isArray(building) && building.id === 'cannon'
  )) as { level?: number; upgradingTo?: number } | undefined
  assert.equal(persistedCannon?.level, 1, 'an admin preview must not mutate the stored village')
  assert.equal(persistedCannon?.upgradingTo, 2)

  await service.close()
})

test('normalized authentication rejects durable bans and suspensions and revokes live sessions', async () => {
  const persistence = new MemoryPersistence()
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(NOW),
    allowGuestSessions: true
  })
  const registered = await service.register(null, 'BlockedChief', 'strong-password', 'admin-auth-spec')
  assert.ok('token' in registered)
  await persistence.transaction(async tx => {
    await tx.admin.upsertModeration({
      playerId: registered.player.id,
      state: 'banned',
      reason: 'test ban',
      until: null,
      updatedAt: NOW,
      revision: 1
    }, null)
  })
  await assert.rejects(service.authenticate(registered.token), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ACCOUNT_BANNED'
  ))
  assert.equal(await persistence.transaction(async tx => (
    await tx.sessions.listForPlayer(registered.player.id, 10)
  ).length), 0)
  await assert.rejects(service.login('BlockedChief', 'strong-password'), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ACCOUNT_BANNED'
  ))

  const upgradeGuest = await service.ensureSession(null, 'admin-auth-upgrade')
  assert.ok('token' in upgradeGuest)
  await persistence.transaction(async tx => {
    await tx.admin.upsertModeration({
      playerId: upgradeGuest.player.id,
      state: 'suspended',
      reason: 'test suspension',
      until: new Date(NOW.getTime() + 60_000),
      updatedAt: NOW,
      revision: 1
    }, null)
  })
  await assert.rejects(
    service.register(upgradeGuest.token, 'UpgradeBlocked', 'strong-password'),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ACCOUNT_SUSPENDED'
  )

  const resumeGuest = await service.ensureSession(null, 'admin-auth-resume')
  assert.ok('token' in resumeGuest)
  await persistence.transaction(async tx => {
    await tx.admin.upsertModeration({
      playerId: resumeGuest.player.id,
      state: 'suspended',
      reason: 'test suspension',
      until: null,
      updatedAt: NOW,
      revision: 1
    }, null)
  })
  await assert.rejects(service.ensureSession(resumeGuest.token), (error: unknown) => (
    error instanceof Error && 'code' in error && error.code === 'ACCOUNT_SUSPENDED'
  ))
  await service.close()
})
