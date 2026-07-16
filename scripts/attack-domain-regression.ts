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
import { getBuildingStats, getTroopStats } from '../src/game/config/GameDefinitions'

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
  check(prepared.rules.simulationVersion === 4, 'new attacks pin the current combat simulation version')
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
  const version2Result = simulateCombat({
    ...partialActive,
    rules: { ...partialActive.rules, simulationVersion: 2 }
  }, 1_000)
  const version1Result = simulateCombat({
    ...partialActive,
    rules: { ...partialActive.rules, simulationVersion: 1 }
  }, 1_000)
  check(version2Result.destruction > version1Result.destruction,
    'simulation v1 remains replayable while v2 credits deterministic partial structural damage')
  // v3 attrition: against the snapshot's cannon, a lone warrior only earns
  // credit for its expected survival window instead of the full 75s budget.
  const partialV3Pinned = {
    ...partialActive,
    rules: { ...partialActive.rules, simulationVersion: 3 }
  }
  const longFightV3 = simulateCombat(partialV3Pinned, 75_000)
  const longFightV2 = simulateCombat({
    ...partialActive,
    rules: { ...partialActive.rules, simulationVersion: 2 }
  }, 75_000)
  check(longFightV3.damageDealt > 0 && longFightV3.damageDealt < longFightV2.damageDealt,
    'simulation v3 attrition banks materially less for a wiped army while v2 replays keep full credit')
  check(simulateCombat(partialV3Pinned, 75_000).resultHash === longFightV3.resultHash,
    'v3 attrition stays a deterministic function of snapshot, seed and events')
  const longFightV4 = simulateCombat(partialActive, 75_000)
  check(longFightV4.simulationVersion === 4 && longFightV4.damageDealt === longFightV3.damageDealt
    && longFightV4.destruction === longFightV3.destruction,
    'v4 credits troops without v4 kit fields exactly like v3 (only the pinned version differs)')
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

  // =========================================================================
  // Rules v4 kit-credit fixtures (2026-07 troop rework). Each branch of the
  // v4 model is exercised against a v3-pinned run of the SAME aggregate, so
  // these double as v3 replay-stability goldens: the v3 branch must keep
  // producing its pre-v4 numbers under the new code.
  // =========================================================================

  function kitSnapshot(id: string, buildings: CombatVillageSnapshot['buildings']): CombatVillageSnapshot {
    return { schemaVersion: 1, snapshotId: id, villageVersion: `kit-${id}`, buildings }
  }

  function kitAttack(
    attackId: string,
    combat: CombatVillageSnapshot,
    army: PrepareAttackInput['requestedArmy'],
    deploys: Array<{ id: string; type: keyof PrepareAttackInput['requestedArmy'] }>,
    rules?: PrepareAttackInput['rules']
  ): AttackAggregate {
    const target: WorldAttackTarget = {
      kind: 'PLAYER',
      targetId: 'defender_kit',
      playerId: 'defender_kit',
      shieldBypass: 'NONE',
      plot: { worldId: 'world_main', x: 4, y: 9, version: 'plot-kit' },
      villageVersion: combat.villageVersion,
      snapshotId: combat.snapshotId,
      snapshotHash: combatSnapshotHash(combat)
    }
    const engaged = prepareAndEngage(playerInput({
      attackId, target, snapshot: combat, requestedArmy: army, ...(rules ? { rules } : {})
    }))
    let attack = engaged
    deploys.forEach((deploy, index) => {
      attack = applyAttackCommand(attack, cas(attack), {
        type: 'DEPLOY',
        commandId: `cmd_${attackId}_${deploy.id}`,
        sequence: index + 1,
        troopInstanceId: `${attackId}_${deploy.id}`,
        troopType: deploy.type,
        gridX: -1,
        gridY: 12
      }, T0 + 200 + index * 100).attack
    })
    return attack
  }

  function atVersion(attack: AttackAggregate, version: number): AttackAggregate {
    return { ...attack, rules: { ...attack.rules, simulationVersion: version } }
  }

  // Defenseless economy base: with zero defense DPS every troop keeps the full
  // credit window, so v4 credit formulas can be asserted exactly.
  const econSnapshot = kitSnapshot('snap_kit_econ', [
    { id: 'kit_econ_hall', type: 'town_hall', level: 1, gridX: 11, gridY: 11 },
    { id: 'kit_econ_farm', type: 'farm', level: 1, gridX: 2, gridY: 2 },
    { id: 'kit_econ_storage', type: 'storage', level: 1, gridX: 6, gridY: 2 },
    { id: 'kit_econ_mine', type: 'mine', level: 1, gridX: 2, gridY: 6 }
  ])
  // One max-level cannon: enough defense DPS that attrition windows bind
  // (per-troop DPS 50 solo / 25 with a two-troop deploy) without wiping the
  // support fixtures' overlap windows.
  const defSnapshot = kitSnapshot('snap_kit_def', [
    { id: 'kit_def_hall', type: 'town_hall', level: 1, gridX: 11, gridY: 11 },
    { id: 'kit_def_cannon', type: 'cannon', level: 4, gridX: 4, gridY: 4 },
    { id: 'kit_def_farm', type: 'farm', level: 1, gridX: 16, gridY: 15 },
    { id: 'kit_def_storage', type: 'storage', level: 1, gridX: 16, gridY: 5 }
  ])

  // --- (a) resource raider: multiplier + resource-first target tier --------
  const goblinStats = getTroopStats('goblinplunderer', 1)
  const goblinAttack = kitAttack('attack_kit_goblin', econSnapshot, { goblinplunderer: 1 }, [
    { id: 'g1', type: 'goblinplunderer' }
  ])
  const goblinBudget = (1 + Math.floor(10_000 / Math.max(150, Math.floor(goblinStats.attackDelay ?? 1_000))))
    * Math.max(0, Math.floor(goblinStats.damage))
  const goblinV4 = simulateCombat(goblinAttack, 10_000)
  const goblinV3 = simulateCombat(atVersion(goblinAttack, 3), 10_000)
  check(goblinV3.damageDealt === goblinBudget,
    'v3-pinned goblin plunderer still earns its plain unmultiplied budget (replay stability)')
  check(goblinV4.damageDealt === goblinBudget * (goblinStats.resourceDamageMultiplier ?? 1),
    'v4 resource raider converts its whole budget at resourceDamageMultiplier against the economy')
  const hallState = goblinV4.buildings.find(building => building.id === 'kit_econ_hall')
  const hallHitPoints = Math.max(1, Math.floor(getBuildingStats('town_hall', 1).maxHealth))
  check(hallState?.remainingHitPoints === hallHitPoints,
    'v4 resource tier spends the goblin budget on resource buildings first (town hall untouched)')

  // --- (b) summoner wave credit -------------------------------------------
  const necroStats = getTroopStats('necromancer', 1)
  const summonStats = getTroopStats(necroStats.summonType as Parameters<typeof getTroopStats>[0], 1)
  const summonCredit = (windowMs: number): number => {
    const dps = Math.max(0, summonStats.damage) * 1_000 / Math.max(150, Math.floor(summonStats.attackDelay ?? 1_000))
    const waves = Math.min(
      necroStats.summonCap ?? Number.MAX_SAFE_INTEGER,
      Math.max(3, Math.floor(windowMs / (necroStats.summonIntervalMs ?? 1)))
    )
    return Math.floor((necroStats.summonCount ?? 0) * waves * dps * (necroStats.summonIntervalMs ?? 0) / 1_000)
  }
  const necroAttack = kitAttack('attack_kit_necro', econSnapshot, { necromancer: 1 }, [
    { id: 'n1', type: 'necromancer' }
  ])
  for (const [durationMs, label] of [
    [20_000, 'interval-counted waves'],
    [6_000, 'the 3-wave floor'],
    [75_000, 'the summonCap ceiling']
  ] as const) {
    const necroV4 = simulateCombat(necroAttack, durationMs)
    const necroV3 = simulateCombat(atVersion(necroAttack, 3), durationMs)
    check(necroV4.damageDealt - necroV3.damageDealt === summonCredit(durationMs),
      `v4 summoner credit adds exactly the documented wave formula (${label})`)
  }

  // --- (c) untargetable deploy window --------------------------------------
  const hawkAttack = kitAttack('attack_kit_hawk', defSnapshot, { hawkeyeassassin: 1 }, [
    { id: 'h1', type: 'hawkeyeassassin' }
  ])
  const hawkV4 = simulateCombat(hawkAttack, 75_000)
  const hawkV3 = simulateCombat(atVersion(hawkAttack, 3), 75_000)
  check(hawkV4.damageDealt > hawkV3.damageDealt,
    'v4 untargetable window extends the assassin attrition lifetime and banks extra strikes')
  check(simulateCombat(hawkAttack, 75_000).resultHash === hawkV4.resultHash,
    'v4 untargetable credit stays deterministic across re-simulation')

  // --- (d) quartermaster cadence aura --------------------------------------
  const qmAttack = kitAttack('attack_kit_qm', defSnapshot, { quartermaster: 1, warrior: 1 }, [
    { id: 'q1', type: 'quartermaster' },
    { id: 'w1', type: 'warrior' }
  ])
  const qmV4 = simulateCombat(qmAttack, 75_000)
  const qmV3 = simulateCombat(atVersion(qmAttack, 3), 75_000)
  check(qmV4.damageDealt > qmV3.damageDealt,
    'v4 quartermaster aura credits allied strikes inside its window at the faster cadence')

  // --- (e) support window extensions ---------------------------------------
  const cartAttack = kitAttack('attack_kit_cart', defSnapshot, { physicianscart: 1, stormmage: 1 }, [
    { id: 'c1', type: 'physicianscart' },
    { id: 'm1', type: 'stormmage' }
  ])
  const cartV4 = simulateCombat(cartAttack, 75_000)
  const cartV3 = simulateCombat(atVersion(cartAttack, 3), 75_000)
  check(cartV4.damageDealt > cartV3.damageDealt,
    "v4 physician's cart heal pulses extend an overlapping ally's credit window")

  const paviseAttack = kitAttack('attack_kit_pavise', defSnapshot, { pavisebearer: 1, archer: 1 }, [
    { id: 'p1', type: 'pavisebearer' },
    { id: 'a1', type: 'archer' }
  ])
  const paviseV4 = simulateCombat(paviseAttack, 75_000)
  const paviseV3 = simulateCombat(atVersion(paviseAttack, 3), 75_000)
  check(paviseV4.damageDealt > paviseV3.damageDealt,
    'v4 pavise bearer redistribution extends a RANGED ally credit window')

  const paviseMeleeAttack = kitAttack('attack_kit_pavise_melee', defSnapshot, { pavisebearer: 1, warrior: 1 }, [
    { id: 'p1', type: 'pavisebearer' },
    { id: 'w1', type: 'warrior' }
  ])
  check(simulateCombat(paviseMeleeAttack, 75_000).damageDealt === simulateCombat(atVersion(paviseMeleeAttack, 3), 75_000).damageDealt,
    'v4 pavise bearer never extends melee allies (the client redirect rule is ranged-only)')

  const towerAttack = kitAttack('attack_kit_tower', defSnapshot, { siegetower: 1, warrior: 1 }, [
    { id: 't1', type: 'siegetower' },
    { id: 'w1', type: 'warrior' }
  ])
  const towerV4 = simulateCombat(towerAttack, 75_000)
  const towerV3 = simulateCombat(atVersion(towerAttack, 3), 75_000)
  check(towerV4.damageDealt > towerV3.damageDealt,
    'v4 siege tower grants overlapping allies the flat pathing-time credit')

  // --- v3-pinned aggregate with a v4-kit troop: rules stay pinned ----------
  const pinnedV3Attack = kitAttack('attack_kit_pinned3', econSnapshot, { goblinplunderer: 1 }, [
    { id: 'g1', type: 'goblinplunderer' }
  ], { simulationVersion: 3 })
  check(pinnedV3Attack.rules.simulationVersion === 3,
    'an aggregate prepared under pinned v3 rules keeps v3 at preparation')
  const pinnedV3Result = simulateCombat(pinnedV3Attack, 10_000)
  check(pinnedV3Result.simulationVersion === 3 && pinnedV3Result.damageDealt === goblinBudget,
    'a stored v3 attack with a v4-kit troop still takes the v3 branches (no multiplier, no tiering)')
  check(simulateCombat(pinnedV3Attack, 10_000).resultHash === pinnedV3Result.resultHash,
    'pinned v3 results regenerate hash-identically under the v4 code')

  console.log(`attack-domain regression: ${checks} checks passed`)
}

run()
