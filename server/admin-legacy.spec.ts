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
    assert.equal(service.adminPlayer(playerId).resources.gold, originalGold + 125)

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
