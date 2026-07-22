import assert from 'node:assert/strict'
import test from 'node:test'
import { MemoryPersistence, type AccountRecord, type VillageRecord } from '../persistence'
import { VILLAGE_SIMULATION_VERSION } from '../domain/village'
import { ensurePersistedBotVillage } from './bot-villages'
import { assertGameplayMutationAllowed } from './maintenance-fence'
import { PersistenceGameService } from './service'
import { materializeVillage } from './village-state'

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
    botRaidCooldowns: {},
    testModeAcknowledgedActivationId: null,
    introBattleCompleted: true
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

  const resourceAdjustment = await service.adminPlayerAction('player_admin_test', {
    type: 'adjust_resources', gold: 250, ore: -50, food: 75, reason: 'support correction'
  })
  assert.equal(resourceAdjustment.changed, true)
  assert.equal(resourceAdjustment.affected, 3,
    'each changed resource is persisted and represented by its own ledger entry')
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
  assert.deepEqual(updated.resources, { gold: 750, ore: 150, food: 175 })
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
  assert.ok(economy.days[0]!.faucets.food >= 75)
  assert.ok(economy.days[0]!.sinks.ore >= 50)

  await assert.rejects(service.adminPlayers('', 101), /limit/i)
  await assert.rejects(service.adminBots({}, 128, 1), /radius/i)
  await assert.rejects(service.adminAudit(251), /limit/i)
  await service.close()
})

test('normalized starter defaults are audited, revision-fenced, and snapshotted by new accounts', async () => {
  const persistence = new MemoryPersistence()
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(NOW),
    starterShieldMs: 0
  })
  const existing = await service.register(null, 'BeforeDefaults', 'strong-password-before', 'starter-before')
  assert.ok('token' in existing)
  if (!('token' in existing)) return
  const existingBefore = await service.getWorld({ playerId: existing.player.id })

  const initialConfig = await service.adminConfig()
  assert.deepEqual(initialConfig.starterVillage.resources, {
    gold: 100_000,
    ore: 100_000,
    food: 100_000
  })
  assert(initialConfig.buildingCatalog.some(building => building.type === 'town_hall'))
  assert.equal(initialConfig.starterLimits.maxBalance, 1_000_000_000)

  await assert.rejects(service.adminOperation({
    type: 'set_starter_village',
    starterVillage: {
      resources: { gold: 100_000, ore: 100_000, food: 100_000 },
      buildings: [
        { type: 'town_hall', level: 1, gridX: 2, gridY: 2 },
        { type: 'army_camp', level: 1, gridX: 2, gridY: 2 }
      ],
      wallLevel: 1
    },
    expectedRevision: initialConfig.revision,
    reason: 'Reject an overlapping starter layout'
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ADMIN_INVALID_INPUT')

  const configuredStarter = {
    resources: { gold: 234_567, ore: 345_678, food: 456_789 },
    buildings: [
      { type: 'town_hall', level: 1, gridX: 2, gridY: 2 },
      { type: 'army_camp', level: 2, gridX: 10, gridY: 10 },
      { type: 'farm', level: 1, gridX: 18, gridY: 18 }
    ],
    wallLevel: 1
  }
  const updated = await service.adminOperation({
    type: 'set_starter_village',
    starterVillage: configuredStarter,
    expectedRevision: initialConfig.revision,
    reason: 'Configure showcase account defaults'
  })
  assert.equal(updated.changed, true)
  assert.equal(updated.affected, 1)

  await assert.rejects(service.adminOperation({
    type: 'set_starter_village',
    starterVillage: configuredStarter,
    expectedRevision: initialConfig.revision,
    reason: 'Reject a stale operator draft'
  }), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ADMIN_CONFIG_STALE')

  assert.deepEqual(
    (await service.getWorld({ playerId: existing.player.id })).resources,
    existingBefore.resources,
    'saving defaults does not mutate an existing village'
  )
  const created = await service.register(null, 'AfterDefaults', 'strong-password-after', 'starter-after')
  assert.ok('token' in created)
  if (!('token' in created)) return
  assert.deepEqual(created.world.resources, configuredStarter.resources,
    'server-issued starter resources may intentionally exceed storage capacity')
  assert.deepEqual(created.world.buildings.map(({ type, level, gridX, gridY }) => ({ type, level, gridX, gridY })),
    configuredStarter.buildings)

  await service.adminOperation({
    type: 'set_maintenance', enabled: true, reason: 'Prepare configured starter reset'
  })
  await service.adminOperation({
    type: 'reset_all_bases', confirmation: 'RESET ALL BASES', reason: 'Apply configured defaults to full reset'
  })
  assert.deepEqual(
    (await service.adminPlayer(existing.player.id)).resources,
    configuredStarter.resources,
    'the explicit full-reset tool consumes the current configured defaults'
  )

  const audit = await service.adminAudit(10)
  assert(audit.some(entry => entry.action === 'set_starter_village'))
  await service.close()
})

test('normalized admin resource deltas apply after pending producer income is materialized', async () => {
  const persistence = new MemoryPersistence()
  const stale = village()
  stale.buildings = [
    { id: 'hall', type: 'town_hall', gridX: 10, gridY: 10, level: 1 },
    { id: 'mine', type: 'mine', gridX: 5, gridY: 5, level: 1 },
    { id: 'farm', type: 'farm', gridX: 15, gridY: 15, level: 1 }
  ]
  stale.ore = 0
  stale.food = 0
  stale.population = { count: 8, lastGrowthAt: NOW.getTime() - 60_000, bornAt: [] }
  stale.simulatedThrough = new Date(NOW.getTime() - 60_000)

  const materialized = structuredClone(stale)
  const pending = materializeVillage(materialized, NOW, { populationLocked: true })
  assert.ok(pending.produced.ore > 0)
  assert.ok(pending.produced.food > 0)
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account())
    await tx.villages.insert(stale)
  })
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })

  const result = await service.adminPlayerAction(stale.playerId, {
    type: 'adjust_resources', ore: -1, food: 2, reason: 'apply after pending production'
  })
  assert.equal(result.changed, true)
  assert.equal(result.affected, 2)
  const persisted = await persistence.transaction(tx => tx.villages.get(stale.playerId))
  assert.equal(persisted?.ore, materialized.ore - 1,
    'the debit is applied to the materialized ore balance')
  assert.equal(persisted?.food, materialized.food + 2,
    'the grant is applied after pending food production')
  assert.equal(persisted?.simulatedThrough.getTime(), NOW.getTime(),
    'the admin transaction persists the producer checkpoint atomically')

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

  await service.adminOperation({
    type: 'set_maintenance', enabled: true, reason: 'Prepare integrity preflight'
  })
  await assert.rejects(service.adminOperation({
    type: 'reset_all_bases', confirmation: 'RESET ALL BASES', reason: 'Exercise integrity preflight'
  }), (error: unknown) => error instanceof Error && 'code' in error
    && error.code === 'ADMIN_RESET_INTEGRITY_FAILED')

  await service.close()
})

test('normalized reset fails closed when a persisted bot world has no durable allocation epoch', async () => {
  const persistence = new MemoryPersistence()
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })
  const session = await service.register(null, 'OrphanBotChief', 'strong-password-orphan', 'orphan-bot-admin')
  assert.ok('token' in session)
  if (!('token' in session)) return

  const orphan = await persistence.transaction(tx => ensurePersistedBotVillage(tx, {
    worldId: 'orphan-realm',
    worldGenerationVersion: 1,
    revisionEpoch: 1,
    x: 4,
    y: 4,
    seed: 4_200_000_003,
    now: NOW
  }))
  await service.adminOperation({
    type: 'set_maintenance', enabled: true, reason: 'Prepare orphan bot integrity check'
  })
  await assert.rejects(service.adminOperation({
    type: 'reset_all_bases',
    confirmation: 'RESET ALL BASES',
    reason: 'Reject missing bot revision authority'
  }), (error: unknown) => error instanceof Error && 'code' in error
    && error.code === 'ADMIN_RESET_INTEGRITY_FAILED')
  assert.ok(await persistence.transaction(tx => tx.world.getBotVillage(orphan.id)),
    'failed preflight leaves the bot authority intact')
  await service.close()
})

test('normalized maintenance fence drains admitted writes before reset and rejects queued stale mutations', async () => {
  const persistence = new MemoryPersistence()
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(NOW),
    starterShieldMs: 7_200_000
  })
  const session = await service.register(null, 'BarrierChief', 'strong-password-barrier', 'reset-barrier')
  assert.ok('token' in session)
  if (!('token' in session)) return

  let enteredResolve!: () => void
  let releaseResolve!: () => void
  const entered = new Promise<void>(resolve => { enteredResolve = resolve })
  const release = new Promise<void>(resolve => { releaseResolve = resolve })
  const admittedWrite = persistence.transaction(async tx => {
    await assertGameplayMutationAllowed(tx)
    enteredResolve()
    await release
    const current = await tx.villages.get(session.player.id)
    assert.ok(current)
    const updated = await tx.villages.update({
      ...current,
      gold: 987_654,
      economyRevision: current.economyRevision + 1,
      lastMutationAt: new Date(NOW)
    }, current.economyRevision)
    assert.equal(updated, true)
  })
  await entered

  let maintenanceFinished = false
  const maintenance = service.adminOperation({
    type: 'set_maintenance',
    enabled: true,
    message: 'Reset barrier active',
    reason: 'Exercise reset transaction barrier'
  }).then(result => {
    maintenanceFinished = true
    return result
  })
  const reset = service.adminOperation({
    type: 'reset_all_bases',
    confirmation: 'RESET ALL BASES',
    reason: 'Reset after admitted mutation drains'
  })
  const staleMutationRejected = assert.rejects(
    service.setBanner({ playerId: session.player.id }, { palette: 1, emblem: 2, pattern: 3 }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'MAINTENANCE'
  )

  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(maintenanceFinished, false, 'maintenance waits for mutations already admitted by the fence')
  releaseResolve()

  await admittedWrite
  await maintenance
  const resetResult = await reset
  await staleMutationRejected
  assert.equal(resetResult.resetSummary?.playerVillagesReset, 1)

  const after = await persistence.transaction(tx => tx.villages.get(session.player.id))
  assert.ok(after)
  assert.notEqual(after.gold, 987_654, 'the drained pre-maintenance write is replaced by the reset')
  assert.equal(after.banner, null, 'the queued stale mutation cannot write after reset')
  await service.close()
})

test('normalized admin reset atomically restores unique starter villages while preserving identity, sessions, and plots', async () => {
  const persistence = new MemoryPersistence()
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(NOW),
    starterShieldMs: 7_200_000
  })
  const first = await service.register(null, 'ResetChiefOne', 'strong-password-one', 'reset-admin-one')
  const second = await service.register(null, 'ResetChiefTwo', 'strong-password-two', 'reset-admin-two')
  assert.ok('token' in first && 'token' in second)
  if (!('token' in first) || !('token' in second)) return

  await service.adminPlayerAction(first.player.id, {
    type: 'adjust_resources', gold: 500, ore: 50, reason: 'Seed reset economy history'
  })
  await service.adminPlayerAction(first.player.id, {
    type: 'set_trophies', trophies: 900, reason: 'Seed reset profile history'
  })
  await service.adminPlayerAction(first.player.id, {
    type: 'send_notice', title: 'Old notice', message: 'Purge this notice', reason: 'Seed reset notices'
  })

  const before = await persistence.transaction(async tx => ({
    firstAccount: await tx.accounts.getById(first.player.id),
    firstVillage: await tx.villages.get(first.player.id),
    secondVillage: await tx.villages.get(second.player.id),
    firstPlot: await tx.world.getPlayerPlot(first.player.id),
    secondPlot: await tx.world.getPlayerPlot(second.player.id)
  }))

  await assert.rejects(service.adminOperation({
    type: 'reset_all_bases', confirmation: 'RESET ALL BASES', reason: 'Maintenance is not enabled'
  }), (error: unknown) => error instanceof Error && 'code' in error
    && error.code === 'ADMIN_MAINTENANCE_REQUIRED')
  await service.adminOperation({
    type: 'set_maintenance', enabled: true, message: 'Resetting every base', reason: 'Prepare guarded base reset'
  })
  await assert.rejects(service.adminOperation({
    type: 'reset_all_bases', confirmation: 'reset all bases', reason: 'Wrong confirmation is rejected'
  }), (error: unknown) => error instanceof Error && 'code' in error
    && error.code === 'ADMIN_RESET_CONFIRMATION_REQUIRED')
  await assert.rejects(service.adminOperation({
    type: 'reset_all_bases', confirmation: 'RESET ALL BASES', reason: 'too short'
  }), /at least 12 characters/i)

  const reset = await service.adminOperation({
    type: 'reset_all_bases',
    confirmation: 'RESET ALL BASES',
    reason: 'Scheduled full authority reset'
  })
  assert.equal(reset.changed, true)
  assert.deepEqual(reset.resetSummary && {
    accountsPreserved: reset.resetSummary.accountsPreserved,
    sessionsPreserved: reset.resetSummary.sessionsPreserved,
    playerPlotsPreserved: reset.resetSummary.playerPlotsPreserved,
    playerVillagesReset: reset.resetSummary.playerVillagesReset
  }, {
    accountsPreserved: 2,
    sessionsPreserved: 2,
    playerPlotsPreserved: 2,
    playerVillagesReset: 2
  })
  assert.ok((reset.resetSummary?.notificationsPurged ?? 0) >= 1)
  assert.ok((reset.resetSummary?.economyRecordsPurged ?? 0) >= 2)
  assert.ok((reset.resetSummary?.auxiliaryRecordsPurged ?? 0) >= 2)

  const after = await persistence.transaction(async tx => ({
    firstAccount: await tx.accounts.getById(first.player.id),
    firstVillage: await tx.villages.get(first.player.id),
    secondVillage: await tx.villages.get(second.player.id),
    firstPlot: await tx.world.getPlayerPlot(first.player.id),
    secondPlot: await tx.world.getPlayerPlot(second.player.id),
    firstSessions: await tx.sessions.listForPlayer(first.player.id, 10),
    secondSessions: await tx.sessions.listForPlayer(second.player.id, 10),
    notices: await tx.notifications.listForPlayer({ playerId: first.player.id, limit: 10 })
  }))
  assert.equal(after.firstAccount?.username, 'ResetChiefOne')
  assert.equal(after.firstAccount?.passwordHash, before.firstAccount?.passwordHash)
  assert.equal(after.firstAccount?.trophies, 0)
  assert.equal(after.firstAccount?.shieldUntil?.getTime(), NOW.getTime() + 7_200_000)
  assert.deepEqual(after.firstAccount?.revengeRights, {})
  assert.deepEqual(after.firstAccount?.botRaidCooldowns, {})
  assert.deepEqual(after.firstPlot, before.firstPlot)
  assert.deepEqual(after.secondPlot, before.secondPlot)
  assert.equal(after.firstSessions.length, 1)
  assert.equal(after.secondSessions.length, 1)
  assert.equal(after.notices.length, 0)
  assert.equal(after.firstVillage?.banner, null)
  assert.equal(after.secondVillage?.banner, null)
  assert.deepEqual(
    { gold: after.firstVillage?.gold, ore: after.firstVillage?.ore, food: after.firstVillage?.food },
    first.world.resources
  )
  assert.ok((after.firstVillage?.layoutRevision ?? 0) > (before.firstVillage?.layoutRevision ?? 0))
  assert.ok((after.secondVillage?.layoutRevision ?? 0) > (before.secondVillage?.layoutRevision ?? 0))
  const firstIds = new Set(after.firstVillage?.buildings.map(building => (
    typeof building === 'object' && building !== null && !Array.isArray(building) ? String(building.id) : ''
  )))
  const secondIds = new Set(after.secondVillage?.buildings.map(building => (
    typeof building === 'object' && building !== null && !Array.isArray(building) ? String(building.id) : ''
  )))
  assert.equal(firstIds.size, after.firstVillage?.buildings.length)
  assert.equal(secondIds.size, after.secondVillage?.buildings.length)
  assert.equal([...firstIds].some(id => secondIds.has(id)), false, 'starter ids are unique across players')
  assert.equal([...firstIds].some(id => before.firstVillage?.buildings.some(building => (
    typeof building === 'object' && building !== null && !Array.isArray(building) && building.id === id
  ))), false, 'the reset issues a fresh building identity epoch')

  assert.equal((await service.adminConfig()).maintenance.enabled, true)
  assert.ok((await service.adminAudit(10)).some(entry => entry.action === 'reset_all_bases'))
  await service.adminOperation({
    type: 'set_maintenance', enabled: false, message: null, reason: 'Reset verification completed'
  })
  const resumed = await service.ensureSession(first.token)
  assert.ok('token' in resumed)
  if ('token' in resumed) assert.equal(resumed.player.id, first.player.id)
  await service.close()
})

test('normalized base reset invalidates pre-reset bot map cache tokens', async () => {
  const persistence = new MemoryPersistence()
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })
  const session = await service.register(null, 'BotEpochChief', 'strong-password-epoch', 'bot-epoch-admin')
  assert.ok('token' in session)
  if (!('token' in session)) return
  const principal = await service.authenticate(session.token)

  const grantMapSight = async () => {
    await persistence.transaction(async tx => {
      const stored = await tx.villages.get(session.player.id)
      assert(stored)
      const expectedRevision = stored.economyRevision
      stored.buildings = [
        ...stored.buildings.filter(building => !building || typeof building !== 'object'
          || Array.isArray(building) || building.type !== 'watchtower'),
        { id: 'admin-reset-watchtower', type: 'watchtower', level: 1, gridX: 2, gridY: 2 }
      ]
      stored.layoutRevision += 1
      stored.appearanceRevision += 1
      stored.economyRevision += 1
      stored.lastMutationAt = new Date(NOW)
      assert.equal(await tx.villages.update(stored, expectedRevision), true)
    })
  }

  await grantMapSight()
  const before = await service.map(
    principal,
    session.player.plotX,
    session.player.plotY,
    1
  )
  const oldBot = before.plots.find(plot => plot.kind === 'bot' && 'world' in plot)
  assert(oldBot, 'the initial map provisions at least one adjacent persisted bot')
  const oldRevision = Number(oldBot.revision)
  const oldOwnerId = String(oldBot.ownerId)
  const oldX = Number(oldBot.x)
  const oldY = Number(oldBot.y)

  await service.adminOperation({
    type: 'set_maintenance', enabled: true, reason: 'Prepare bot cache epoch reset'
  })
  const reset = await service.adminOperation({
    type: 'reset_all_bases',
    confirmation: 'RESET ALL BASES',
    reason: 'Verify replacement bot cache identity'
  })
  assert.ok((reset.resetSummary?.botVillagesPurged ?? 0) >= 1)
  const allocation = await persistence.transaction(tx => tx.world.getAllocation('main'))
  assert.ok((allocation?.botRevisionEpoch ?? 0) > oldRevision)

  // The reset correctly removes the watchtower; restore sight directly while
  // maintenance is still active so the first public map read after reopening
  // is the one carrying the stale client token under test.
  await grantMapSight()
  await service.adminOperation({
    type: 'set_maintenance', enabled: false, reason: 'Bot cache epoch reset completed'
  })
  const known = `${oldX},${oldY}:${oldOwnerId}:${oldRevision}`
  const after = await service.map(
    principal,
    session.player.plotX,
    session.player.plotY,
    1,
    known
  )
  const replacement = after.plots.find(plot => plot.x === oldX && plot.y === oldY)
  assert(replacement)
  assert.equal(replacement.ownerId, oldOwnerId, 'coordinate-scoped bot identity remains stable')
  assert.ok(Number(replacement.revision) > oldRevision, 'replacement revision crosses the purge epoch')
  assert.ok('world' in replacement, 'a pre-reset known token must not suppress the replacement world')

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

test('normalized admin overflow survives world loads, ordinary income, debits, and saves', async () => {
  const persistence = new MemoryPersistence()
  const storedVillage = village()
  storedVillage.buildings = [
    { id: 'hall', type: 'town_hall', gridX: 10, gridY: 10, level: 1 }
  ]
  storedVillage.population = { count: 5, lastGrowthAt: NOW.getTime(), bornAt: [] }
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account())
    await tx.villages.insert(storedVillage)
    await tx.world.ensureRegion({
      worldId: 'main', regionId: 'main:admin-overflow', regionX: 0, regionY: 0,
      size: 32, generationVersion: 1, createdAt: NOW
    })
    await tx.world.assign({
      worldId: 'main', x: 0, y: 0, regionId: 'main:admin-overflow',
      playerId: storedVillage.playerId, plotVersion: 1, assignedAt: NOW,
      leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
    })
  })
  let now = new Date(NOW)
  const service = new PersistenceGameService(persistence, { now: () => new Date(now) })
  const principal = { playerId: storedVillage.playerId }

  await service.adminPlayerAction(storedVillage.playerId, {
    type: 'adjust_resources', ore: 100_000, food: 1_000_000, reason: 'restore production incident'
  })
  const restored = { ore: 100_200, food: 1_000_100 }

  now = new Date(NOW.getTime() + 60_000)
  const loaded = await service.getWorld(principal)
  assert.deepEqual(
    { ore: loaded.resources.ore, food: loaded.resources.food },
    restored,
    'the next authoritative world materialization must not collapse an admin restore to storage caps'
  )

  const cappedIncome = await service.applyResources(principal, {
    resource: 'ore', delta: 25, reason: 'rock_haul', requestId: 'over-cap-normal-income'
  }) as { ore: number }
  assert.equal(cappedIncome.ore, restored.ore,
    'normal income has no headroom while an existing balance is over capacity')
  const debited = await service.applyResources(principal, {
    resource: 'food', delta: -9, reason: 'support verification', requestId: 'over-cap-debit'
  }) as { food: number }
  assert.equal(debited.food, restored.food - 9,
    'an ordinary debit applies to the persisted overflow instead of first clamping it')

  const beforeSave = await service.getWorld(principal)
  const saved = await service.saveWorld(principal, {
    world: beforeSave,
    requestId: 'over-cap-noop-save'
  })
  assert.deepEqual(
    { ore: saved.resources.ore, food: saved.resources.food },
    { ore: restored.ore, food: restored.food - 9 }
  )
  const persisted = await persistence.transaction(tx => tx.villages.get(storedVillage.playerId))
  assert.deepEqual(
    { ore: persisted?.ore, food: persisted?.food },
    { ore: restored.ore, food: restored.food - 9 }
  )

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

test('normalized admin test mode supports global state and tri-state player overrides', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account())
    await tx.villages.insert(village())
  })
  const service = new PersistenceGameService(persistence, { now: () => new Date(NOW) })

  assert.deepEqual((await service.adminConfig()).testMode, { enabled: false, overrideCount: 0 })
  assert.deepEqual((await service.adminPlayer('player_admin_test')).testMode, {
    override: null,
    effective: false
  })

  await service.adminOperation({ type: 'set_test_mode', enabled: true, reason: 'Enable realm testing' })
  assert.deepEqual((await service.adminPlayer('player_admin_test')).testMode, {
    override: null,
    effective: true
  })

  await service.adminPlayerAction('player_admin_test', {
    type: 'set_test_mode', override: false, reason: 'Exclude this account'
  })
  assert.deepEqual((await service.adminConfig()).testMode, { enabled: true, overrideCount: 1 })
  assert.deepEqual((await service.adminPlayer('player_admin_test')).testMode, {
    override: false,
    effective: false
  })

  await service.adminPlayerAction('player_admin_test', {
    type: 'set_test_mode', override: null, reason: 'Restore realm inheritance'
  })
  assert.deepEqual((await service.adminConfig()).testMode, { enabled: true, overrideCount: 0 })
  assert.deepEqual((await service.adminPlayer('player_admin_test')).testMode, {
    override: null,
    effective: true
  })
  await service.close()
})

test('normalized Test Mode claim is atomic and intro completion is idempotent', async () => {
  const service = new PersistenceGameService(new MemoryPersistence(), {
    now: () => new Date(NOW),
    starterShieldMs: 0
  })
  const created = await service.register(
    null,
    'ClaimRuntimeChief',
    'strong-password-runtime',
    'claim-runtime'
  )
  assert.ok('token' in created)
  if (!('token' in created)) return
  const principal = { playerId: created.player.id }
  assert.equal(created.features.introBattleRequired, true)
  assert.deepEqual(await service.completeIntroBattle(principal), {
    ok: true,
    introBattleRequired: false
  })
  assert.deepEqual(await service.completeIntroBattle(principal), {
    ok: true,
    introBattleRequired: false
  })

  await service.adminOperation({ type: 'set_test_mode', enabled: true, reason: 'First runtime activation' })
  const first = (await service.homeSync(principal)).features
  assert.ok(first.testModeActivationId)
  assert.equal(first.testModeAnnouncementPending, true)
  const claims = await Promise.all([
    service.claimTestModeAnnouncement(principal, { activationId: first.testModeActivationId }),
    service.claimTestModeAnnouncement(principal, { activationId: first.testModeActivationId })
  ])
  assert.deepEqual(claims.map(claim => claim.show).sort(), [false, true])
  assert.equal((await service.homeSync(principal)).features.testModeAnnouncementPending, false)

  await service.adminPlayerAction(principal.playerId, {
    type: 'set_test_mode', override: true, reason: 'Keep this account continuously enabled'
  })
  await service.adminOperation({ type: 'set_test_mode', enabled: false, reason: 'Disable inherited runtime mode' })
  await service.adminOperation({ type: 'set_test_mode', enabled: true, reason: 'Re-enable inherited runtime mode' })
  const continuous = (await service.homeSync(principal)).features
  assert.equal(continuous.testModeActivationId, first.testModeActivationId)
  assert.equal(continuous.testModeAnnouncementPending, false)

  await service.adminPlayerAction(principal.playerId, {
    type: 'set_test_mode', override: false, reason: 'Turn this runtime account off'
  })
  await service.adminPlayerAction(principal.playerId, {
    type: 'set_test_mode', override: null, reason: 'Activate this runtime account again'
  })
  const second = (await service.homeSync(principal)).features
  assert.ok(second.testModeActivationId)
  assert.notEqual(second.testModeActivationId, first.testModeActivationId)
  assert.equal(second.testModeAnnouncementPending, true)
  await assert.rejects(
    service.claimTestModeAnnouncement(principal, { activationId: first.testModeActivationId }),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'TEST_MODE_ACTIVATION_STALE'
  )
  assert.equal((await service.claimTestModeAnnouncement(principal, {
    activationId: second.testModeActivationId
  })).show, true)
  await service.adminOperation({ type: 'set_test_mode', enabled: false, reason: 'End the second runtime activation' })
  await service.adminOperation({ type: 'set_test_mode', enabled: true, reason: 'Begin the third runtime activation' })
  const third = (await service.homeSync(principal)).features
  assert.ok(third.testModeActivationId)
  assert.notEqual(third.testModeActivationId, second.testModeActivationId)
  assert.equal(third.testModeAnnouncementPending, true)
  const resumed = await service.ensureSession(created.token)
  assert.ok('token' in resumed)
  if ('token' in resumed) {
    assert.equal(resumed.features.introBattleRequired, false)
    assert.equal(resumed.features.testModeActivationId, third.testModeActivationId)
    assert.equal(resumed.features.testModeAnnouncementPending, true)
  }
  await service.close()
})

test('normalized test mode is authoritative for sessions, spending, upgrades, and troop unlocks', async () => {
  const service = new PersistenceGameService(new MemoryPersistence(), {
    now: () => new Date(NOW),
    starterShieldMs: 0
  })
  const session = await service.register(null, 'TestModeRuntime', 'strong-password-runtime', 'test-mode-runtime')
  assert.ok('token' in session)
  if (!('token' in session)) return
  const principal = { playerId: session.player.id }

  const ordinaryWorld = await service.getWorld(principal)
  const ordinaryMine = ordinaryWorld.buildings.find(building => building.type === 'mine')
  assert.ok(ordinaryMine)
  const timedProposal = structuredClone(ordinaryWorld)
  timedProposal.buildings.find(building => building.id === ordinaryMine.id)!.level += 1
  const pending = await service.saveWorld(principal, {
    world: timedProposal,
    requestId: 'test-mode-existing-timer'
  })
  assert.equal(pending.buildings.find(building => building.id === ordinaryMine.id)?.upgradingTo, ordinaryMine.level + 1)

  await service.adminOperation({
    type: 'set_test_mode', enabled: true, reason: 'Exercise every test-mode entitlement'
  })
  const heartbeat = await service.homeSync(principal)
  assert.equal(heartbeat.features.infiniteResources, true)
  assert.equal(heartbeat.features.testMode, true)
  assert.equal(heartbeat.features.testModeAnnouncementPending, true)
  assert.ok(heartbeat.features.testModeActivationId)
  assert.equal(heartbeat.features.introBattleRequired, true)
  assert.deepEqual(heartbeat.upgradePolicy, { fixedDurationMs: 0, timeScale: 0 })
  const enabled = await service.ensureSession(session.token)
  assert.ok('token' in enabled)
  if (!('token' in enabled)) return
  assert.deepEqual(enabled.features, heartbeat.features)
  assert.deepEqual(enabled.world.upgradePolicy, { fixedDurationMs: 0, timeScale: 0 })

  const before = await service.getWorld(principal)
  const expeditedMine = before.buildings.find(building => building.id === ordinaryMine.id)!
  assert.equal(expeditedMine.level, ordinaryMine.level + 1, 'enabling test mode completes an existing timer')
  assert.equal(expeditedMine.upgradingTo, undefined)
  const mine = before.buildings.find(building => building.type === 'mine')
  assert.ok(mine, 'starter village supplies an upgradeable mine')
  const proposal = structuredClone(before)
  const proposedMine = proposal.buildings.find(building => building.id === mine.id)!
  proposedMine.level += 1
  const upgraded = await service.saveWorld(principal, {
    world: proposal,
    requestId: 'test-mode-instant-upgrade'
  })
  const completedMine = upgraded.buildings.find(building => building.id === mine.id)!
  assert.equal(completedMine.level, proposedMine.level)
  assert.equal(completedMine.upgradingTo, undefined)
  assert.equal(completedMine.upgradeEndsAt, undefined)
  assert.deepEqual(upgraded.resources, before.resources, 'upgrades do not consume the test wallet')

  const trained = await service.trainTroop(principal, {
    type: 'archer', count: 1, requestId: 'test-mode-locked-troop'
  }) as { army: Record<string, number>; gold: number; food: number }
  assert.equal(trained.army.archer, 1, 'a level-two Army Camp unlock is bypassed')
  assert.equal(trained.gold, upgraded.resources.gold)
  assert.equal(trained.food, upgraded.resources.food)

  const spent = await service.applyResources(principal, {
    resource: 'gold', delta: -1_000_000, requestId: 'test-mode-infinite-spend'
  }) as { applied: boolean; gold: number }
  assert.equal(spent.applied, true)
  assert.equal(spent.gold, upgraded.resources.gold)

  await service.adminPlayerAction(session.player.id, {
    type: 'set_test_mode', override: false, reason: 'Verify a player-specific exclusion'
  })
  const disabled = await service.ensureSession(session.token)
  assert.ok('token' in disabled)
  if ('token' in disabled) {
    assert.deepEqual(disabled.features, {
      infiniteResources: false,
      testMode: false,
      testModeActivationId: null,
      testModeAnnouncementPending: false,
      introBattleRequired: true
    })
  }
  await service.close()
})
