import type { SerializedWorld } from '../../src/game/data/Models'
import { engageAttack, applyAttackCommand, prepareAttack } from './domain'
import { combatSnapshotHash } from './simulation'
import type {
  ApplyAttackCommandResult,
  AttackAggregate,
  AttackCommand,
  AttackSelectionSource,
  CombatVillageSnapshot,
  TroopCounts
} from './types'

export interface PrepareBotAttackInput {
  attackId: string
  attackerId: string
  attackerName: string
  sourceArmyVersion: number
  selectionSource: Extract<AttackSelectionSource, 'BOT_MAP' | 'BOT_MATCHMADE'>
  worldId: string
  worldGenerationVersion: number
  x: number
  y: number
  seed: number
  world: SerializedWorld
  reservedArmy: TroopCounts
  troopLevel: number
  startedAt: number
  expiresAt: number
  raidableShare: number
}

/** Adapt one seeded camp into the target-agnostic attack state machine. */
export function prepareBotAttack(input: PrepareBotAttackInput): AttackAggregate {
  const snapshot: CombatVillageSnapshot = {
    schemaVersion: 1,
    snapshotId: `snap_${input.attackId}`,
    villageVersion: `bot_${input.seed}_v1`,
    buildings: input.world.buildings.map(building => ({
      id: building.id,
      type: building.type,
      level: building.level,
      gridX: building.gridX,
      gridY: building.gridY
    }))
  }
  const botId = `bot_${input.x}_${input.y}_${input.seed}`
  const durationMs = Math.max(1_000, input.expiresAt - input.startedAt)
  return prepareAttack({
    attackId: input.attackId,
    attackerId: input.attackerId,
    attackerName: input.attackerName,
    selectionSource: input.selectionSource,
    target: {
      kind: 'BOT',
      targetId: botId,
      botId,
      seed: input.seed,
      plot: {
        worldId: input.worldId,
        x: input.x,
        y: input.y,
        version: `generation_${input.worldGenerationVersion}_${input.seed}`
      },
      villageVersion: snapshot.villageVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: combatSnapshotHash(snapshot)
    },
    snapshot,
    simulationSeed: `bot_seed_${input.seed}`,
    rewardPolicy: {
      lootCaps: {
        gold: Math.floor(Math.max(0, Number(input.world.resources.gold) || 0) * input.raidableShare),
        ore: 0,
        food: 0
      },
      winTrophyBase: 0,
      winTrophyPerFivePercent: 0,
      lossTrophyDelta: 0
    },
    requestedArmy: input.reservedArmy,
    troopLevel: input.troopLevel,
    now: input.startedAt,
    rules: {
      preparingTtlMs: durationMs,
      engagedTtlMs: durationMs,
      maxCombatDurationMs: durationMs
    }
  }, {
    reserveArmy: request => ({
      reservationId: `reserve_${input.attackId}`,
      sourceArmyVersion: input.sourceArmyVersion,
      reserved: { ...request.requested },
      troopLevel: request.troopLevel
    })
  })
}

/** Engage an immutable BOT target when its first compact command arrives. */
export function applyBotAttackCommand(
  attack: AttackAggregate,
  command: AttackCommand,
  now: number,
  expiresAt: number
): ApplyAttackCommandResult {
  let engaged = attack
  if (engaged.phase === 'PREPARING') {
    engaged = engageAttack(engaged, {
      expectedPhase: engaged.phase,
      expectedVersion: engaged.version
    }, now, {
      validateAndLockTarget: () => ({
        available: true,
        targetId: engaged.target.targetId,
        plot: { ...engaged.target.plot },
        villageVersion: engaged.target.villageVersion,
        shieldUntil: 0,
        observedAt: now,
        engagementLease: {
          leaseId: `lease_${engaged.attackId}`,
          acquiredAt: now,
          expiresAt
        }
      })
    })
  }
  return applyAttackCommand(engaged, {
    expectedPhase: engaged.phase,
    expectedVersion: engaged.version
  }, command, now)
}
