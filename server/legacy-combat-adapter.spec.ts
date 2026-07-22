import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TROOP_DEFINITIONS, type TroopType } from '../src/game/config/GameDefinitions'
import type { SerializedWorld } from '../src/game/data/Models'
import { GameService, generatedTroopHasRootDeployment } from './game'

test('legacy replay damage ceiling credits every declarative chain and splash kit', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-legacy-combat-'))
  try {
    const game = new GameService(dataRoot) as unknown as {
      rootDamageCeiling(world: SerializedWorld, type: TroopType, level: number, activeMs: number): number
      flush(): boolean
    }
    const world: SerializedWorld = {
      id: 'cluster',
      ownerId: 'enemy',
      buildings: [
        { id: 'c0', type: 'cannon', gridX: 0, gridY: 0, level: 1 },
        { id: 'c1', type: 'cannon', gridX: 1, gridY: 0, level: 1 },
        { id: 'c2', type: 'cannon', gridX: 0, gridY: 1, level: 1 },
        { id: 'c3', type: 'cannon', gridX: 1, gridY: 1, level: 1 }
      ],
      resources: { gold: 0, ore: 0, food: 0 },
      lastSaveTime: 0
    }
    const activeAtFirstStrike: Partial<Record<TroopType, number>> = {
      stormmage: 0,
      mobilemortar: 1_000,
      trebuchet: 1_500
    }

    for (const [rawType, activeMs] of Object.entries(activeAtFirstStrike)) {
      const type = rawType as TroopType
      const ceiling = game.rootDamageCeiling(world, type, 1, activeMs ?? 0)
      assert(
        ceiling > TROOP_DEFINITIONS[type].damage,
        `${type} must receive clustered-target credit from its declarative area kit`
      )
    }
    assert.equal(game.flush(), true)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('generated Skeleton and Roman Warrior rows require and refresh from their trained roots symmetrically', () => {
  assert.equal(generatedTroopHasRootDeployment('romanwarrior', { phalanx: 1 }), true)
  assert.equal(generatedTroopHasRootDeployment('romanwarrior', { necromancer: 1 }), false)
  assert.equal(generatedTroopHasRootDeployment('skeleton', { necromancer: 1 }), true)
  assert.equal(generatedTroopHasRootDeployment('skeleton', { phalanx: 1 }), false)
  assert.equal(generatedTroopHasRootDeployment('warrior', { warrior: 1 }), false)
})

test('legacy PvP starts and idempotent retries expose the immutable reserved army', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-legacy-reservation-'))
  try {
    const game = new GameService(dataRoot)
    const attackerSession = game.register(null, 'ReserveAttacker', 'valid-password-123')
    const defenderSession = game.register(null, 'ReserveDefender', 'valid-password-123')
    assert.ok('token' in attackerSession)
    assert.ok('token' in defenderSession)
    if (!('token' in attackerSession) || !('token' in defenderSession)) return

    const attacker = game.authenticate(attackerSession.token)
    const defender = game.authenticate(defenderSession.token)
    attacker.army = { warrior: 2 }
    defender.shieldUntil = 0

    const started = game.matchmake(attacker, { requestId: 'legacy-reserved-army' }, attackerSession.token)
    assert.deepEqual(started.reservedArmy, { warrior: 2 })
    const retry = game.matchmake(attacker, { requestId: 'legacy-reserved-army' }, attackerSession.token)
    assert.equal(retry.attackId, started.attackId)
    assert.deepEqual(retry.reservedArmy, started.reservedArmy,
      'the idempotent retry preserves the reservation snapshot exactly')
    assert.equal(game.flush(), true)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('legacy runtime persists and incrementally serves the ordered replay-v2 stream', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-legacy-replay-v2-'))
  try {
    const game = new GameService(dataRoot)
    const attackerSession = game.register(null, 'ReplayV2Attacker', 'valid-password-123')
    const defenderSession = game.register(null, 'ReplayV2Defender', 'valid-password-123')
    assert.ok('token' in attackerSession)
    assert.ok('token' in defenderSession)
    if (!('token' in attackerSession) || !('token' in defenderSession)) return

    const attacker = game.authenticate(attackerSession.token)
    const defender = game.authenticate(defenderSession.token)
    attacker.army = { warrior: 1 }
    defender.shieldUntil = 0
    const started = game.matchmake(attacker, { requestId: 'legacy-replay-v2-start' }, attackerSession.token)
    game.pushCommands(attacker, {
      attackId: started.attackId,
      commands: [{
        type: 'DEPLOY',
        commandId: 'legacy-replay-v2-deploy',
        sequence: 1,
        troopInstanceId: 'legacy-replay-v2-root',
        troopType: 'warrior',
        gridX: 0,
        gridY: 0
      }]
    })
    const target = started.world.buildings.find(building => building.type !== 'wall')!
    const correction = {
      t: 20,
      destruction: 0,
      goldLooted: 0,
      buildings: [{ id: target.id, health: 1, isDestroyed: false }],
      troops: []
    }
    const request = {
      attackId: started.attackId,
      replayV2: {
        chunks: [{
          kind: 'event', sequence: 1, t: 10,
          event: {
            version: 1, id: 'legacy-impact-1', seed: 17, type: 'projectile.impact',
            payload: { projectileId: 'legacy-projectile-1', targetId: target.id }
          }
        }, {
          kind: 'keyframe', sequence: 2, t: 20, terminal: true, frame: correction
        }]
      }
    }
    assert.deepEqual(game.pushFrames(attacker, request), {
      frameCount: 0,
      acceptedFrames: 0,
      replacedFrames: 0,
      duplicateFrames: 0,
      droppedFrames: 0,
      acceptedV2: 2,
      duplicateV2: 0,
      droppedV2: 0,
      lastV2Sequence: 2,
      terminalOnlyV2: false
    })
    const retry = game.pushFrames(attacker, request)
    assert.equal(retry.acceptedV2, 0)
    assert.equal(retry.duplicateV2, 2)

    const full = game.getReplay(defender, started.attackId)
    assert.equal(full.replayVersion, 2)
    assert.deepEqual(full.v2Chunks?.map(chunk => chunk.sequence), [1, 2])
    assert.deepEqual(full.v2Chunks?.[0], request.replayV2.chunks[0])
    const incremental = game.getReplay(defender, started.attackId, 20, 1)
    assert.deepEqual(incremental.frames, [])
    assert.deepEqual(incremental.v2Chunks?.map(chunk => chunk.sequence), [2])
    assert.equal(incremental.enemyWorld, undefined)

    assert.equal(game.flush(), true)
    const restarted = new GameService(dataRoot)
    const restored = restarted.getReplay(restarted.authenticate(defenderSession.token), started.attackId)
    assert.deepEqual(restored.v2Chunks?.map(chunk => chunk.sequence), [1, 2])
    const restoredTerminal = restored.v2Chunks?.at(-1)
    assert.equal(restoredTerminal?.kind, 'keyframe')
    assert.equal(restoredTerminal?.kind === 'keyframe' && restoredTerminal.terminal, true)
    assert.equal(restarted.flush(), true)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
