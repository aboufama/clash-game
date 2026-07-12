import assert from 'node:assert/strict'
import {
  AttackDomainError,
  applyAttackCommand,
  cancelAttack,
  combatSnapshotHash,
  compactReplay,
  engageAttack,
  expireAttack,
  finalizeAttack,
  prepareAttack,
  settleAttack,
  simulateCombat,
  type ArmyReservationRequest,
  type AttackAggregate,
  type AttackCas,
  type AttackSettlementReceipt,
  type CombatVillageSnapshot,
  type PrepareAttackInput,
  type TargetObservation,
  type WorldAttackTarget
} from '../server/attack-domain/index'

let checks = 0

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message)
  checks += 1
}

function expectCode(code: AttackDomainError['code'], run: () => unknown, message: string): void {
  assert.throws(run, error => error instanceof AttackDomainError && error.code === code, message)
  checks += 1
}

const T0 = 1_720_000_000_000

function cas(attack: AttackAggregate): AttackCas {
  return { expectedPhase: attack.phase, expectedVersion: attack.version }
}

function snapshot(id: string, version: string): CombatVillageSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: id,
    villageVersion: version,
    buildings: [
      { id: `${id}_hall`, type: 'town_hall', level: 1, gridX: 11, gridY: 11 },
      { id: `${id}_cannon`, type: 'cannon', level: 1, gridX: 4, gridY: 4 },
      { id: `${id}_farm`, type: 'farm', level: 1, gridX: 16, gridY: 15 }
    ]
  }
}

function playerInput(overrides: Partial<PrepareAttackInput> = {}): PrepareAttackInput {
  const combat = snapshot('snap_player', 'village-7')
  const target: WorldAttackTarget = {
    kind: 'PLAYER',
    targetId: 'defender_1',
    playerId: 'defender_1',
    shieldBypass: 'NONE',
    plot: { worldId: 'world_main', x: 7, y: -3, version: 'plot-19' },
    villageVersion: combat.villageVersion,
    snapshotId: combat.snapshotId,
    snapshotHash: combatSnapshotHash(combat)
  }
  return {
    attackId: 'attack_1',
    attackerId: 'attacker_1',
    attackerName: 'Tester',
    selectionSource: 'MATCHMADE',
    target,
    snapshot: combat,
    simulationSeed: 'seed_attack_1',
    rewardPolicy: {
      lootCaps: { gold: 1_000, ore: 100, food: 50 },
      winTrophyBase: 15,
      winTrophyPerFivePercent: 1,
      lossTrophyDelta: -12
    },
    requestedArmy: { golem: 1, warrior: 2 },
    troopLevel: 1,
    now: T0,
    ...overrides
  }
}

const reserveArmy = (request: ArmyReservationRequest) => ({
  reservationId: `reserve_${request.attackId}`,
  sourceArmyVersion: 41,
  reserved: { ...request.requested },
  troopLevel: request.troopLevel
})

function validObservation(attack: AttackAggregate, now: number): TargetObservation {
  return {
    available: true,
    targetId: attack.target.targetId,
    plot: { ...attack.target.plot },
    villageVersion: attack.target.villageVersion,
    shieldUntil: 0,
    observedAt: now,
    ...(attack.target.kind === 'PLAYER'
      ? { engagementLease: { leaseId: `lease_${attack.attackId}`, acquiredAt: now, expiresAt: now + 20 * 60_000 } }
      : {})
  }
}

function prepareAndEngage(input = playerInput()): AttackAggregate {
  const prepared = prepareAttack(input, { reserveArmy })
  return engageAttack(prepared, cas(prepared), input.now + 100, {
    validateAndLockTarget: request => validObservation(prepared, request.now)
  })
}

function deployGolem(engaged: AttackAggregate, now = T0 + 200): AttackAggregate {
  return applyAttackCommand(engaged, cas(engaged), {
    type: 'DEPLOY',
    commandId: 'command_deploy_1',
    sequence: 1,
    troopInstanceId: 'golem_instance_1',
    troopType: 'golem',
    gridX: -0.75,
    gridY: 12.25
  }, now).attack
}

function run(): void {
  const prepared = prepareAttack(playerInput(), { reserveArmy })
  check(prepared.phase === 'PREPARING' && prepared.version === 1, 'preparation starts at PREPARING v1')
  check(prepared.rules.simulationVersion === 2, 'new attacks pin the current combat simulation version')
  check(prepared.reservation.state === 'HELD' && prepared.reservation.reserved.golem === 1, 'preparation holds an exact army reservation')
  check(prepared.target.kind === 'PLAYER' && prepared.target.plot.x === 7, 'matchmade PLAYER target retains its real world plot')

  expectCode('ARMY_RESERVATION_INVALID', () => prepareAttack(playerInput({ attackId: 'attack_bad_reservation' }), {
    reserveArmy: request => ({ ...reserveArmy(request), reserved: { warrior: 1 } })
  }), 'partial reservation grants are rejected')

  expectCode('CAS_MISMATCH', () => engageAttack(prepared, { expectedPhase: 'PREPARING', expectedVersion: 99 }, T0 + 100, {
    validateAndLockTarget: request => validObservation(prepared, request.now)
  }), 'engagement enforces phase/version CAS')

  expectCode('TARGET_SHIELDED', () => engageAttack(
    prepareAttack(playerInput({ attackId: 'attack_shielded' }), { reserveArmy }),
    { expectedPhase: 'PREPARING', expectedVersion: 1 },
    T0 + 100,
    {
      validateAndLockTarget: request => ({
        ...validObservation(prepareAttack(playerInput({ attackId: 'attack_shadow' }), { reserveArmy }), request.now),
        targetId: 'defender_1',
        shieldUntil: request.now + 60_000,
        engagementLease: { leaseId: 'lease_shielded', acquiredAt: request.now, expiresAt: request.now + 60_000 }
      })
    }
  ), 'PLAYER shields are revalidated at engagement')

  expectCode('TARGET_MOVED', () => engageAttack(
    prepareAttack(playerInput({ attackId: 'attack_moved' }), { reserveArmy }),
    { expectedPhase: 'PREPARING', expectedVersion: 1 },
    T0 + 100,
    {
      validateAndLockTarget: request => {
        const moved = validObservation(prepareAttack(playerInput({ attackId: 'attack_moved_probe' }), { reserveArmy }), request.now)
        return { ...moved, targetId: 'defender_1', plot: { ...moved.plot, x: moved.plot.x + 1 } }
      }
    }
  ), 'plot occupancy is revalidated at engagement')

  const engaged = engageAttack(prepared, cas(prepared), T0 + 100, {
    validateAndLockTarget: request => validObservation(prepared, request.now)
  })
  check(engaged.phase === 'ENGAGED' && engaged.version === 2 && Boolean(engaged.engagement), 'engagement atomically installs the target lease')

  expectCode('COMMAND_SEQUENCE_GAP', () => applyAttackCommand(engaged, cas(engaged), {
    type: 'DEPLOY', commandId: 'gap_command', sequence: 2, troopInstanceId: 'gap_troop', troopType: 'warrior', gridX: 0, gridY: 0
  }, T0 + 200), 'command sequences cannot skip')

  const firstDeployCommand = {
    type: 'DEPLOY' as const,
    commandId: 'command_deploy_1',
    sequence: 1,
    troopInstanceId: 'golem_instance_1',
    troopType: 'golem' as const,
    gridX: -0.75,
    gridY: 12.25
  }
  const firstDeploy = applyAttackCommand(engaged, cas(engaged), firstDeployCommand, T0 + 200)
  const active = firstDeploy.attack
  check(active.phase === 'ACTIVE' && active.version === 3, 'first deployment is the only ENGAGED -> ACTIVE transition')
  check(active.reservation.deployed.golem === 1 && active.timestamps.combatStartedAt === T0 + 200, 'deployment consumes only the reservation ledger and starts combat time')

  const duplicateDeploy = applyAttackCommand(active, cas(engaged), firstDeployCommand, T0 + 500)
  check(duplicateDeploy.duplicate && duplicateDeploy.attack === active && duplicateDeploy.receipt.appliedVersion === 3, 'same command retry succeeds before CAS evaluation')
  expectCode('COMMAND_ID_REUSED', () => applyAttackCommand(active, cas(active), { ...firstDeployCommand, gridX: 1 }, T0 + 500), 'command ids cannot be reused with changed payloads')

  let abilityHookCalls = 0
  const abilityCommand = {
    type: 'ABILITY' as const,
    commandId: 'command_ability_2',
    sequence: 2,
    abilityId: 'bombard_1',
    targetBuildingId: 'snap_player_hall'
  }
  const abilityApplied = applyAttackCommand(active, cas(active), abilityCommand, T0 + 1_000, {
    authorizeAbility: request => {
      abilityHookCalls += 1
      return {
        authorizationId: `ability_receipt_${request.abilityId}`,
        effect: { kind: 'DIRECT_DAMAGE', damage: 1_000, targetBuildingId: request.targetBuildingId }
      }
    }
  })
  check(abilityApplied.attack.version === 4 && abilityHookCalls === 1, 'ability authorization is normalized into one compact event')
  const abilityDuplicate = applyAttackCommand(abilityApplied.attack, cas(active), abilityCommand, T0 + 2_000, {
    authorizeAbility: () => { throw new Error('duplicate must not re-authorize') }
  })
  check(abilityDuplicate.duplicate && abilityHookCalls === 1, 'ability retry does not consume inventory twice')

  const finalizeAt = T0 + 80_000
  const finalizedA = finalizeAttack(abilityApplied.attack, cas(abilityApplied.attack), 'OBJECTIVE_COMPLETE', finalizeAt)
  const finalizedB = finalizeAttack(structuredClone(abilityApplied.attack), cas(abilityApplied.attack), 'OBJECTIVE_COMPLETE', finalizeAt)
  check(finalizedA.phase === 'FINALIZING' && (finalizedA.finalization?.result.damageDealt ?? 0) > 0, 'finalization derives a non-client-authored combat result')
  check(finalizedA.finalization?.result.resultHash === finalizedB.finalization?.result.resultHash, 'same snapshot, seed, events and time produce the same result hash')
  const recomputed = simulateCombat(finalizedA, finalizedA.finalization?.result.durationMs ?? 0)
  check(recomputed.resultHash === finalizedA.finalization?.result.resultHash, 'result can be independently regenerated by a settlement/replay worker')

  const partialPrepared = prepareAttack(playerInput({
    attackId: 'attack_versioned_partial',
    requestedArmy: { warrior: 1 }
  }), { reserveArmy })
  const partialEngaged = engageAttack(partialPrepared, cas(partialPrepared), T0 + 100, {
    validateAndLockTarget: request => validObservation(partialPrepared, request.now)
  })
  const partialActive = applyAttackCommand(partialEngaged, cas(partialEngaged), {
    type: 'DEPLOY', commandId: 'partial_deploy', sequence: 1,
    troopInstanceId: 'partial_warrior', troopType: 'warrior', gridX: 0, gridY: 0
  }, T0 + 200).attack
  const version2Result = simulateCombat(partialActive, 1_000)
  const version1Result = simulateCombat({
    ...partialActive,
    rules: { ...partialActive.rules, simulationVersion: 1 }
  }, 1_000)
  check(version2Result.destruction > version1Result.destruction,
    'simulation v1 remains replayable while v2 credits deterministic partial structural damage')
  check(finalizedA.finalization?.settlement.resourceMode === 'TRANSFER' && Boolean(finalizedA.finalization.settlement.defender), 'PLAYER outcome creates one self-contained transfer plan')
  check(finalizedA.finalization?.settlement.consumeArmy.golem === 1 && finalizedA.finalization.settlement.releaseArmy.warrior === 2, 'settlement consumes deployed troops and releases unused reservation')

  const finalization = finalizedA.finalization
  assert.ok(finalization)
  const receipt: AttackSettlementReceipt = {
    settlementId: finalization.settlement.settlementId,
    transactionId: 'transaction_attack_1',
    resultHash: finalization.result.resultHash,
    committedAt: finalizeAt + 1,
    applied: {
      loot: { ...finalization.result.loot },
      trophyDelta: finalization.result.requestedTrophyDelta,
      consumedArmy: { ...finalization.settlement.consumeArmy }
    }
  }
  const settled = settleAttack(finalizedA, cas(finalizedA), receipt)
  check(settled.phase === 'SETTLED' && settled.reservation.state === 'COMMITTED', 'durable settlement receipt closes the attack and reservation')
  check(settleAttack(settled, cas(finalizedA), receipt) === settled, 'same durable settlement receipt is idempotent before CAS evaluation')
  expectCode('SETTLEMENT_MISMATCH', () => settleAttack(settled, cas(settled), { ...receipt, transactionId: 'different_transaction' }), 'a conflicting settlement retry is rejected')

  const publicReplay = compactReplay(settled)
  const participantReplay = compactReplay(settled, { includeEconomy: true })
  check(publicReplay.events.length < 10 && !Object.prototype.hasOwnProperty.call(publicReplay.result ?? {}, 'loot'), 'public replay is a compact event log with economy redacted')
  check(Object.prototype.hasOwnProperty.call(participantReplay.result ?? {}, 'loot'), 'participant replay may opt into settlement fields')

  const cancelled = cancelAttack(prepareAttack(playerInput({ attackId: 'attack_cancel' }), { reserveArmy }), { expectedPhase: 'PREPARING', expectedVersion: 1 }, T0 + 50, 'player backed out')
  check(cancelled.phase === 'CANCELLED' && cancelled.reservation.state === 'RELEASED', 'pre-combat cancellation releases the army')

  const expiring = prepareAttack(playerInput({ attackId: 'attack_expire' }), { reserveArmy })
  const expired = expireAttack(expiring, cas(expiring), expiring.timestamps.expiresAt)
  check(expired.phase === 'EXPIRED' && expired.reservation.state === 'RELEASED', 'unused preparation expiry is terminal and free')

  const surrenderEngaged = prepareAndEngage(playerInput({ attackId: 'attack_surrender_early' }))
  const earlySurrenderCommand = { type: 'SURRENDER' as const, commandId: 'surrender_early', sequence: 1 }
  const earlySurrender = applyAttackCommand(surrenderEngaged, cas(surrenderEngaged), earlySurrenderCommand, T0 + 200)
  check(earlySurrender.attack.phase === 'CANCELLED', 'surrender before deployment cancels without settlement')
  check(applyAttackCommand(earlySurrender.attack, cas(surrenderEngaged), earlySurrenderCommand, T0 + 300).duplicate, 'early surrender retry is idempotent in a terminal phase')

  const surrenderActiveBase = deployGolem(prepareAndEngage(playerInput({ attackId: 'attack_surrender_active' })))
  const activeSurrender = applyAttackCommand(surrenderActiveBase, cas(surrenderActiveBase), {
    type: 'SURRENDER', commandId: 'surrender_active', sequence: 2
  }, T0 + 10_000).attack
  check(activeSurrender.phase === 'FINALIZING' && activeSurrender.finalization?.reason === 'SURRENDER', 'surrender after deployment produces a deterministic settlement plan')

  const botCombat = snapshot('snap_bot', 'bot-layout-4')
  const botTarget: WorldAttackTarget = {
    kind: 'BOT',
    targetId: 'bot_7_-3',
    botId: 'bot_7_-3',
    seed: 73,
    plot: { worldId: 'world_main', x: 9, y: -3, version: 'bot-plot-stable' },
    villageVersion: botCombat.villageVersion,
    snapshotId: botCombat.snapshotId,
    snapshotHash: combatSnapshotHash(botCombat)
  }
  const botPrepared = prepareAttack(playerInput({
    attackId: 'attack_bot', selectionSource: 'BOT_MAP', target: botTarget, snapshot: botCombat
  }), { reserveArmy })
  const botEngaged = engageAttack(botPrepared, cas(botPrepared), T0 + 100, {
    validateAndLockTarget: request => validObservation(botPrepared, request.now)
  })
  const botActive = deployGolem(botEngaged)
  const botFinal = finalizeAttack(botActive, cas(botActive), 'OBJECTIVE_COMPLETE', finalizeAt)
  check(botFinal.finalization?.settlement.resourceMode === 'MINT' && !botFinal.finalization.settlement.defender, 'BOT uses the same attack machine with bounded mint settlement')
  check(botFinal.finalization?.result.requestedTrophyDelta === 0, 'non-player targets never mutate rating')

  console.log(`attack-domain regression: ${checks} checks passed`)
}

run()
