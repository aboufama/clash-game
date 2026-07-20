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
