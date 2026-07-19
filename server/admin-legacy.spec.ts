import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ApiError, GameService } from './game'

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

    service.adminOperation({
      type: 'set_maintenance',
      enabled: true,
      message: 'Applying a safe migration',
      reason: 'Exercise the maintenance gate'
    })
    assert.equal(service.adminConfig().maintenance.enabled, true)
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
    assert.equal(restarted.adminPlayer(playerId).resources.gold, originalGold + 125)
    assert.ok(restarted.adminAudit(250).some(entry => entry.action === 'adjust_resources'))
    assert.ok(restarted.flush())
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
