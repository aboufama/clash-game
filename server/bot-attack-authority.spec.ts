import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GameService } from './game'

assert.notEqual(process.env.CLASH_ALLOW_LEGACY_FRAME_COMMANDS, '1', 'authority test must run without the legacy bridge')

const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-bot-authority-'))
try {
  const game = new GameService(dataRoot)
  const session = game.ensureSession(undefined, 'bot-authority-spec')
  const player = game.authenticate(session.token)
  game.trainTroop(player, { type: 'warrior', count: 2, requestId: 'train-two-warriors' })

  const started = game.botStart(player, { requestId: 'start-authoritative-bot' }, session.token)
  const command = {
    type: 'DEPLOY' as const,
    commandId: 'deploy_root_one',
    sequence: 1,
    troopInstanceId: 'root_one',
    troopType: 'warrior' as const,
    gridX: 0,
    gridY: 0
  }
  const first = game.pushCommands(player, { attackId: started.raidId, commands: [command] })
  assert.equal(first.phase, 'ACTIVE')
  assert.equal(first.lastCommandSequence, 1)

  const retry = game.pushCommands(player, { raidId: started.raidId, commands: [command] })
  assert.equal(retry.receipts[0].duplicate, true)
  assert.equal(retry.lastCommandSequence, 1)

  // These legacy fields are hostile input in production. Only root_one was
  // commanded, so the invented 100% result and second warrior must do nothing.
  const settled = game.botSettle(player, {
    raidId: started.raidId,
    destruction: 100,
    deployed: { warrior: 2 },
    requestId: 'settle-authoritative-bot'
  })
  assert.equal(settled.army.warrior, 1)

  assert.equal(game.flush(), true)
  const stored = JSON.parse(readFileSync(path.join(dataRoot, 'bot-raids', `${started.raidId}.json`), 'utf8'))
  assert.equal(stored.authority.target.kind, 'BOT')
  assert.equal(stored.authority.phase, 'SETTLED')
  assert.equal(stored.authority.reservation.deployed.warrior, 1)
  assert.ok(stored.authority.finalization.result.destruction < 100)
  assert.equal(stored.preparedSettlement.resultHash, stored.authority.finalization.result.resultHash)

  console.log('bot attack authority: command-only settlement passed')
} finally {
  rmSync(dataRoot, { recursive: true, force: true })
}
