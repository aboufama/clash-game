import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ApiError, GameService } from './game'

function provisionLegacyBot(service: GameService, x: number, y: number, seed: number) {
  return (service as unknown as {
    persistedBotVillageAt(x: number, y: number, seed: number): { id: string; revision: number }
  }).persistedBotVillageAt(x, y, seed)
}

test('legacy JSON runtime provides durable, audited admin parity', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-legacy-'))
  try {
    const service = new GameService(root)
    const session = service.register(null, 'AdminSpecPlayer', 'valid-password-123')
    assert.ok('token' in session)
    if (!('token' in session)) return
    const playerId = session.player.id
    const originalGold = session.world.resources.gold
    const originalOre = Number(session.world.resources.ore ?? 0)
    const originalFood = Number(session.world.resources.food ?? 0)

    assert.equal(service.adminOverview().players.total, 1)
    assert.equal(service.adminPlayers('AdminSpec', 10)[0]?.id, playerId)
    assert.deepEqual(service.adminBots(undefined, undefined, 10), [], 'admin reads never synthesize bot villages')
    const villagePreview = service.adminPlayer(playerId).village
    assert.ok(villagePreview)
    assert.equal(villagePreview.ownerId, playerId)
    assert.equal(villagePreview.username, 'AdminSpecPlayer')
    assert.equal(villagePreview.buildings.length, session.world.buildings.length)
    assert.ok(villagePreview.stoneMaturity >= 0 && villagePreview.stoneMaturity <= 1)
    assert.equal(JSON.stringify(villagePreview).includes('gold'), false)

    assert.throws(
      () => service.adminPlayerAction(playerId, { type: 'set_trophies', trophies: 25, reason: 'x' }),
      (error: unknown) => error instanceof ApiError && error.code === 'ADMIN_INVALID_INPUT'
    )

    const resourceResult = service.adminPlayerAction(playerId, {
      type: 'adjust_resources',
      gold: 125,
      ore: 20,
      food: 10,
      reason: 'Correct a support incident'
    })
    assert.equal(resourceResult.changed, true)
    assert.equal(resourceResult.affected, 3)
    assert.deepEqual(service.adminPlayer(playerId).resources, {
      gold: originalGold + 125,
      ore: originalOre + 20,
      food: originalFood + 10
    })
    const resourceEconomy = service.adminEconomy(1).days[0]
    assert.ok(resourceEconomy)
    assert.ok(resourceEconomy.faucets.gold >= 125)
    assert.ok(resourceEconomy.faucets.ore >= 20)
    assert.ok(resourceEconomy.faucets.food >= 10)

    service.adminPlayerAction(playerId, {
      type: 'send_notice',
      title: 'Village restored',
      message: 'Your missing resources have been restored.',
      severity: 'info',
      reason: 'Tell the player the correction is complete'
    })
    const principal = service.authenticate(session.token)
    const notifications = service.listNotifications(principal)
    const notice = notifications[0]
    assert.ok(notice && 'kind' in notice && notice.kind === 'admin_notice')
    assert.equal(notice.read, false)

    service.adminPlayerAction(playerId, {
      type: 'set_access',
      state: 'suspended',
      until: Date.now() + 60_000,
      reason: 'Investigating suspicious account activity'
    })
    assert.equal(service.adminPlayer(playerId).access, 'suspended')
    assert.throws(
      () => service.authenticate(session.token),
      (error: unknown) => error instanceof ApiError && error.status === 401
    )
    assert.throws(
      () => service.login('AdminSpecPlayer', 'valid-password-123'),
      (error: unknown) => error instanceof ApiError && error.code === 'ACCOUNT_SUSPENDED'
    )

    service.adminPlayerAction(playerId, {
      type: 'set_access',
      state: 'active',
      until: null,
      reason: 'Investigation completed successfully'
    })
    const resumed = service.login('AdminSpecPlayer', 'valid-password-123')
    assert.equal(resumed.player.id, playerId)
    const botSeed = 4_200_000_001
    const retiredBot = provisionLegacyBot(service, 1, 0, botSeed)

    service.adminOperation({
      type: 'set_maintenance',
      enabled: true,
      message: 'Applying a safe migration',
      reason: 'Exercise the maintenance gate'
    })
    assert.equal(service.adminConfig().maintenance.enabled, true)
    assert.throws(
      () => service.adminOperation({
        type: 'reset_all_bases',
        confirmation: 'reset all bases',
        reason: 'Reject an incorrect reset phrase'
      }),
      (error: unknown) => error instanceof ApiError && error.code === 'ADMIN_RESET_CONFIRMATION_REQUIRED'
    )
    const reset = service.adminOperation({
      type: 'reset_all_bases',
      confirmation: 'RESET ALL BASES',
      reason: 'Exercise durable legacy base reset'
    })
    assert.equal(reset.resetSummary?.accountsPreserved, 1)
    assert.equal(reset.resetSummary?.sessionsPreserved, 1)
    assert.equal(reset.resetSummary?.playerPlotsPreserved, 1)
    assert.equal(reset.resetSummary?.playerVillagesReset, 1)
    assert.equal(reset.resetSummary?.botVillagesPurged, 1)
    assert.equal(service.adminPlayer(playerId).resources.gold, originalGold)
    assert.equal(service.adminPlayer(playerId).trophies, 0)
    assert.equal(service.adminPlayer(playerId).village?.banner ?? null, null)
    assert.throws(
      () => service.authenticate(resumed.token),
      (error: unknown) => error instanceof ApiError && error.code === 'GAME_MAINTENANCE'
    )
    service.adminOperation({
      type: 'set_maintenance',
      enabled: false,
      message: null,
      reason: 'Migration completed successfully'
    })

    const audit = service.adminAudit(250)
    assert.ok(audit.length >= 6)
    assert.ok(audit.every(entry => entry.reason.length >= 3 && entry.outcome === 'success'))
    assert.ok(service.flush())

    const restarted = new GameService(root)
    assert.equal(restarted.adminConfig().maintenance.enabled, false)
    assert.equal(restarted.adminPlayer(playerId).resources.gold, originalGold)
    assert.equal(restarted.adminPlayer(playerId).trophies, 0)
    const replacementBot = provisionLegacyBot(restarted, 1, 0, botSeed)
    assert.equal(replacementBot.id, retiredBot.id)
    assert.ok(replacementBot.revision > retiredBot.revision,
      'a durable reset epoch prevents a legacy bot cache-token collision after restart')
    assert.ok(restarted.adminAudit(250).some(entry => entry.action === 'adjust_resources'))
    assert.ok(restarted.adminAudit(250).some(entry => entry.action === 'reset_all_bases'))
    assert.ok(restarted.flush())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy starter defaults persist and apply only at creation unless a full reset is requested', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-starter-legacy-'))
  try {
    const service = new GameService(root)
    const existing = service.register(null, 'LegacyBefore', 'valid-password-123')
    assert.ok('token' in existing)
    if (!('token' in existing)) return
    const existingBefore = service.getWorld(service.authenticate(existing.token))
    const initialConfig = service.adminConfig()
    const starterVillage = {
      resources: { gold: 210_000, ore: 220_000, food: 230_000 },
      buildings: [
        { type: 'town_hall', level: 1, gridX: 2, gridY: 2 },
        { type: 'army_camp', level: 2, gridX: 10, gridY: 10 },
        { type: 'mine', level: 1, gridX: 18, gridY: 18 }
      ],
      wallLevel: 1
    }
    const changed = service.adminOperation({
      type: 'set_starter_village',
      starterVillage,
      expectedRevision: initialConfig.revision,
      reason: 'Configure durable legacy starter defaults'
    })
    assert.equal(changed.changed, true)
    assert.deepEqual(service.getWorld(service.authenticate(existing.token)).resources, existingBefore.resources,
      'changing defaults never re-grants an existing account')

    const created = service.register(null, 'LegacyAfter', 'valid-password-456')
    assert.ok('token' in created)
    if (!('token' in created)) return
    assert.deepEqual(created.world.resources, starterVillage.resources)
    assert.deepEqual(created.world.buildings.map(({ type, level, gridX, gridY }) => ({ type, level, gridX, gridY })),
      starterVillage.buildings)
    assert.ok(service.flush())

    const restarted = new GameService(root)
    assert.deepEqual(restarted.adminConfig().starterVillage, starterVillage,
      'the configured template survives a JSON runtime restart')
    const afterRestart = restarted.register(null, 'LegacyRestart', 'valid-password-789')
    assert.ok('token' in afterRestart)
    if (!('token' in afterRestart)) return
    assert.deepEqual(afterRestart.world.resources, starterVillage.resources,
      'post-restart creation still uses the persisted template')

    restarted.adminOperation({
      type: 'set_maintenance', enabled: true, reason: 'Prepare configured legacy reset'
    })
    restarted.adminOperation({
      type: 'reset_all_bases', confirmation: 'RESET ALL BASES', reason: 'Apply configured legacy starter defaults'
    })
    assert.deepEqual(restarted.adminPlayer(existing.player.id).resources, starterVillage.resources,
      'the explicit full reset consumes the configured starter snapshot')
    assert.ok(restarted.adminAudit(50).some(entry => entry.action === 'set_starter_village'))
    assert.ok(restarted.flush())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy admin overflow survives world loads, debits, saves, and restart without earning past cap', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-overflow-legacy-'))
  try {
    const service = new GameService(root)
    const session = service.register(null, 'OverflowChief', 'valid-password-123')
    assert.ok('token' in session)
    if (!('token' in session)) return
    const playerId = session.player.id
    const restored = {
      ore: Number(session.world.resources.ore ?? 0) + 100_000,
      food: Number(session.world.resources.food ?? 0) + 1_000_000
    }

    service.adminPlayerAction(playerId, {
      type: 'adjust_resources', ore: 100_000, food: 1_000_000,
      reason: 'Restore a production incident'
    })
    assert.deepEqual(service.adminPlayer(playerId).resources, {
      gold: session.world.resources.gold,
      ...restored
    })

    const player = service.authenticate(session.token)
    const loaded = service.getWorld(player)
    assert.deepEqual(
      { ore: loaded.resources.ore, food: loaded.resources.food },
      restored,
      'the next legacy world materialization must retain the authoritative restore'
    )
    const cappedIncome = service.applyResources(player, {
      resource: 'ore', delta: 25, reason: 'rock_haul', requestId: 'legacy-over-cap-income'
    })
    assert.equal(cappedIncome.ore, restored.ore,
      'ordinary income cannot increase an already-over-cap stock')
    const oreDebit = service.applyResources(player, {
      resource: 'ore', delta: -11, reason: 'support verification', requestId: 'legacy-over-cap-ore-debit'
    })
    const foodDebit = service.applyResources(player, {
      resource: 'food', delta: -7, reason: 'support verification', requestId: 'legacy-over-cap-food-debit'
    })
    const afterDebits = { ore: restored.ore - 11, food: restored.food - 7 }
    assert.equal(oreDebit.ore, afterDebits.ore)
    assert.equal(foodDebit.food, afterDebits.food)

    const beforeSave = service.getWorld(player)
    const saved = service.saveWorld(player, { world: beforeSave, requestId: 'legacy-over-cap-save' })
    assert.deepEqual(
      { ore: saved.resources.ore, food: saved.resources.food },
      afterDebits
    )
    assert.ok(service.flush())

    const restarted = new GameService(root)
    const reopened = restarted.getWorld(restarted.authenticate(session.token))
    assert.deepEqual(
      { ore: reopened.resources.ore, food: reopened.resources.food },
      afterDebits,
      'the legacy JSON reload must not normalize restored balances back to storage capacity'
    )
    assert.ok(restarted.flush())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy admin adjustments materialize producer income first and persist zero-delta catch-up', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-accrual-legacy-'))
  try {
    const service = new GameService(root)
    const session = service.register(null, 'AccrualChief', 'valid-password-123')
    assert.ok('token' in session)
    if (!('token' in session)) return
    assert.ok(session.world.buildings.some(building => building.type === 'mine'),
      'the starter village supplies the producer used by this regression')
    const player = service.authenticate(session.token)

    player.ore = 0
    player.lastAccrualAt = Date.now() - 10 * 60_000
    player.simulatedThrough = player.lastAccrualAt
    player.productionRemainders = { ore: 0, food: 0 }
    const granted = service.adminPlayerAction(player.id, {
      type: 'adjust_resources', ore: 10, reason: 'Apply grant after pending mine income'
    })
    assert.equal(granted.changed, true)
    assert.ok(player.ore > 10,
      'pending mine income lands before the admin grant instead of after it')
    assert.ok(service.flush())

    // Flush clears the prior dirty marker. This second catch-up therefore
    // proves that a zero admin delta still persists the advanced checkpoint.
    player.ore = 0
    player.lastAccrualAt = Date.now() - 10 * 60_000
    player.simulatedThrough = player.lastAccrualAt
    player.productionRemainders = { ore: 0, food: 0 }
    const caughtUp = service.adminPlayerAction(player.id, {
      type: 'adjust_resources', ore: 0, reason: 'Persist pending mine income only'
    })
    assert.equal(caughtUp.changed, false)
    assert.equal(caughtUp.affected, 0)
    assert.ok(player.ore > 0)
    const persistedOre = player.ore
    assert.ok(service.flush())

    const restarted = new GameService(root)
    assert.equal(restarted.adminPlayer(player.id).resources.ore, persistedOre)
    assert.ok(restarted.flush())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy JSON runtime deterministically recovers a pending base reset journal before serving', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-reset-recovery-'))
  try {
    const service = new GameService(root)
    const session = service.register(null, 'RecoveryChief', 'valid-password-123')
    assert.ok('token' in session)
    if (!('token' in session)) return
    const playerId = session.player.id
    service.adminPlayerAction(playerId, {
      type: 'adjust_resources', gold: 5_000, reason: 'Seed journal recovery state'
    })
    service.adminOperation({
      type: 'set_maintenance', enabled: true, message: 'Recovering reset', reason: 'Prepare journal recovery test'
    })
    const botSeed = 4_200_000_002
    const retiredBot = provisionLegacyBot(service, 2, 0, botSeed)
    assert.ok(service.flush())

    const worldStatePath = path.join(root, 'world-state', 'main.json')
    const worldState = JSON.parse(readFileSync(worldStatePath, 'utf8')) as Record<string, unknown>
    const revisionEpoch = 1_900_000_000_001
    worldState.baseResetJournal = {
      resetId: 'base_reset_recovery_spec',
      auditId: 'admin_audit_recovery_spec',
      reason: 'Recover interrupted legacy reset',
      startedAt: 1_900_000_000_000,
      starterShieldUntil: 1_900_007_200_000,
      revisionEpoch,
      botRevisionEpoch: revisionEpoch,
      summary: {
        accountsPreserved: 1,
        sessionsPreserved: 1,
        playerPlotsPreserved: 1,
        playerVillagesReset: 1,
        botVillagesPurged: 1,
        attacksPurged: 0,
        combatRecordsPurged: 0,
        notificationsPurged: 0,
        economyRecordsPurged: 1,
        auxiliaryRecordsPurged: 0
      }
    }
    writeFileSync(worldStatePath, JSON.stringify(worldState), 'utf8')

    const recovered = new GameService(root)
    const detail = recovered.adminPlayer(playerId)
    assert.equal(detail.resources.gold, session.world.resources.gold)
    assert.equal(detail.trophies, 0)
    assert.equal(detail.revisions.profile, revisionEpoch)
    assert.equal(detail.revisions.layout, revisionEpoch)
    assert.equal(detail.village?.banner ?? null, null)
    assert.ok(recovered.adminAudit(250).some(entry => entry.id === 'admin_audit_recovery_spec'))
    const recoveredWorldState = JSON.parse(readFileSync(worldStatePath, 'utf8')) as Record<string, unknown>
    assert.equal('baseResetJournal' in recoveredWorldState, false)
    assert.equal(recoveredWorldState.botRevisionEpoch, revisionEpoch)

    const secondRestart = new GameService(root)
    assert.equal(secondRestart.adminPlayer(playerId).revisions.profile, revisionEpoch,
      'completed recovery must not advance the deterministic revision epoch again')
    const replacementBot = provisionLegacyBot(secondRestart, 2, 0, botSeed)
    assert.equal(replacementBot.id, retiredBot.id)
    assert.ok(replacementBot.revision > retiredBot.revision,
      'journal recovery must preserve its bot epoch through the following restart')
    secondRestart.adminOperation({
      type: 'set_maintenance', enabled: false, reason: 'Recovery verification completed'
    })
    assert.equal(secondRestart.authenticate(session.token).id, playerId)
    assert.ok(secondRestart.flush())
    const twiceRestartedWorldState = JSON.parse(readFileSync(worldStatePath, 'utf8')) as Record<string, unknown>
    assert.equal(twiceRestartedWorldState.botRevisionEpoch, revisionEpoch)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy admin test mode persists global state and explicit player exclusions', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-test-mode-'))
  try {
    const service = new GameService(root)
    const session = service.register(null, 'TestModeChief', 'valid-password-123')
    assert.ok('token' in session)
    if (!('token' in session)) return
    const playerId = session.player.id

    assert.deepEqual(service.adminConfig().testMode, { enabled: false, overrideCount: 0 })
    service.adminOperation({ type: 'set_test_mode', enabled: true, reason: 'Enable realm testing' })
    service.adminPlayerAction(playerId, {
      type: 'set_test_mode', override: false, reason: 'Exclude this account'
    })
    assert.deepEqual(service.adminPlayer(playerId).testMode, { override: false, effective: false })
    assert.ok(service.flush())

    const restarted = new GameService(root)
    assert.deepEqual(restarted.adminConfig().testMode, { enabled: true, overrideCount: 1 })
    assert.deepEqual(restarted.adminPlayer(playerId).testMode, { override: false, effective: false })
    restarted.adminPlayerAction(playerId, {
      type: 'set_test_mode', override: null, reason: 'Restore realm inheritance'
    })
    assert.deepEqual(restarted.adminPlayer(playerId).testMode, { override: null, effective: true })
    assert.deepEqual(restarted.adminConfig().testMode, { enabled: true, overrideCount: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy test mode is authoritative for sessions, spending, upgrades, and troop unlocks', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'clash-admin-test-mode-gameplay-'))
  try {
    const service = new GameService(root)
    const session = service.register(null, 'TestModeLegacy', 'valid-password-123')
    assert.ok('token' in session)
    if (!('token' in session)) return
    const player = service.authenticate(session.token)

    const ordinaryWorld = service.getWorld(player)
    const ordinaryMine = ordinaryWorld.buildings.find(building => building.type === 'mine')
    assert.ok(ordinaryMine)
    const timedProposal = structuredClone(ordinaryWorld)
    timedProposal.buildings.find(building => building.id === ordinaryMine.id)!.level += 1
    const pending = service.saveWorld(player, {
      world: timedProposal,
      requestId: 'legacy-test-mode-existing-timer'
    })
    assert.equal(pending.buildings.find(building => building.id === ordinaryMine.id)?.upgradingTo, ordinaryMine.level + 1)

    service.adminOperation({
      type: 'set_test_mode', enabled: true, reason: 'Exercise every legacy test entitlement'
    })
    const heartbeat = service.homeSync(player)
    assert.deepEqual(heartbeat.features, { infiniteResources: true, testMode: true })
    assert.deepEqual(heartbeat.upgradePolicy, { fixedDurationMs: 0, timeScale: 0 })
    const enabled = service.ensureSession(session.token, 'test-mode-legacy')
    assert.ok('token' in enabled)
    if (!('token' in enabled)) return
    assert.deepEqual(enabled.features, { infiniteResources: true, testMode: true })
    assert.deepEqual(enabled.world.upgradePolicy, { fixedDurationMs: 0, timeScale: 0 })

    const before = service.getWorld(player)
    const expeditedMine = before.buildings.find(building => building.id === ordinaryMine.id)!
    assert.equal(expeditedMine.level, ordinaryMine.level + 1, 'enabling test mode completes an existing timer')
    assert.equal(expeditedMine.upgradingTo, undefined)
    const mine = before.buildings.find(building => building.type === 'mine')
    assert.ok(mine, 'starter village supplies an upgradeable mine')
    const proposal = structuredClone(before)
    const proposedMine = proposal.buildings.find(building => building.id === mine.id)!
    proposedMine.level += 1
    const upgraded = service.saveWorld(player, {
      world: proposal,
      requestId: 'legacy-test-mode-instant-upgrade'
    })
    const completedMine = upgraded.buildings.find(building => building.id === mine.id)!
    assert.equal(completedMine.level, proposedMine.level)
    assert.equal(completedMine.upgradingTo, undefined)
    assert.equal(completedMine.upgradeEndsAt, undefined)
    assert.deepEqual(upgraded.resources, before.resources, 'upgrades do not consume the test wallet')

    const trained = service.trainTroop(player, {
      type: 'archer', count: 1, requestId: 'legacy-test-mode-locked-troop'
    })
    assert.equal(trained.army.archer, 1, 'a level-two Army Camp unlock is bypassed')
    assert.equal(trained.gold, upgraded.resources.gold)
    assert.equal(trained.food, upgraded.resources.food)

    const spent = service.applyResources(player, {
      resource: 'gold', delta: -1_000_000, requestId: 'legacy-test-mode-infinite-spend'
    })
    assert.equal(spent.applied, true)
    assert.equal(spent.gold, upgraded.resources.gold)

    service.adminPlayerAction(session.player.id, {
      type: 'set_test_mode', override: false, reason: 'Verify a legacy player exclusion'
    })
    const disabled = service.ensureSession(session.token, 'test-mode-legacy-disabled')
    assert.ok('token' in disabled)
    if ('token' in disabled) {
      assert.deepEqual(disabled.features, { infiniteResources: false, testMode: false })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
