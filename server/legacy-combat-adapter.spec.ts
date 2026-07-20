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
