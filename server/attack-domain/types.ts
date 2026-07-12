import type { BuildingType, PlayerTroopType } from '../../src/game/config/GameDefinitions'

export const ATTACK_PHASES = [
  'PREPARING',
  'ENGAGED',
  'ACTIVE',
  'FINALIZING',
  'SETTLED',
  'CANCELLED',
  'EXPIRED'
] as const

export type AttackPhase = typeof ATTACK_PHASES[number]
export type TerminalAttackPhase = Extract<AttackPhase, 'SETTLED' | 'CANCELLED' | 'EXPIRED'>
export type ReservableTroopType = PlayerTroopType
export type TroopCounts = Partial<Record<ReservableTroopType, number>>

export interface AttackCas {
  expectedPhase: AttackPhase
  expectedVersion: number
}

export interface WorldPlotRef {
  worldId: string
  x: number
  y: number
  /** Changes whenever this coordinate is vacated or claimed by a different occupant. */
  version: string
}

interface AttackTargetBase {
  targetId: string
  plot: WorldPlotRef
  /** Public/combat version of the target village, separate from private economy revisions. */
  villageVersion: string
  snapshotId: string
  snapshotHash: string
}

export interface PlayerAttackTarget extends AttackTargetBase {
  kind: 'PLAYER'
  playerId: string
  /** A revenge authorization may pierce one otherwise-valid shield. */
  shieldBypass: 'NONE' | 'REVENGE'
  /** Revenge is revalidated at engagement; omitted legacy grants cannot bypass. */
  shieldBypassExpiresAt?: number
}

export interface BotAttackTarget extends AttackTargetBase {
  kind: 'BOT'
  botId: string
  seed: number
}

export interface ScenarioAttackTarget extends AttackTargetBase {
  kind: 'SCENARIO'
  scenarioId: string
}

/**
 * A neighbor and a matchmade player are both PLAYER targets. Selection is audit
 * metadata only; it never selects a second combat implementation.
 */
export type WorldAttackTarget = PlayerAttackTarget | BotAttackTarget | ScenarioAttackTarget

export type AttackSelectionSource = 'NEIGHBOR' | 'MATCHMADE' | 'REVENGE' | 'BOT_MAP' | 'BOT_MATCHMADE' | 'PRACTICE'

export interface CombatBuildingSnapshot {
  id: string
  type: BuildingType
  level: number
  gridX: number
  gridY: number
}

export interface CombatVillageSnapshot {
  schemaVersion: 1
  snapshotId: string
  villageVersion: string
  buildings: CombatBuildingSnapshot[]
}

export interface ResourceAmounts {
  gold: number
  ore: number
  food: number
}

export interface AttackRewardPolicy {
  lootCaps: ResourceAmounts
  /** Player-vs-player only. Other target kinds always settle with zero rating delta. */
  winTrophyBase: number
  winTrophyPerFivePercent: number
  lossTrophyDelta: number
}

export interface AttackRulesSnapshot {
  simulationVersion: number
  preparingTtlMs: number
  engagedTtlMs: number
  maxCombatDurationMs: number
  maxDamageCreditMs: number
  maxCommands: number
  maxDeployments: number
  deploymentMargin: number
}

export interface ArmyReservationRequest {
  attackId: string
  attackerId: string
  requested: TroopCounts
  troopLevel: number
}

/** Returned by the account/army adapter from the same transaction that creates the attack. */
export interface ArmyReservationGrant {
  reservationId: string
  sourceArmyVersion: number
  reserved: TroopCounts
  troopLevel: number
}

export interface ArmyReservation extends ArmyReservationGrant {
  state: 'HELD' | 'RELEASED' | 'COMMITTED'
  deployed: TroopCounts
}

export interface EngagementLease {
  leaseId: string
  acquiredAt: number
  expiresAt: number
}

export interface TargetObservation {
  available: boolean
  targetId: string
  plot: WorldPlotRef
  villageVersion: string
  shieldUntil: number
  observedAt: number
  /** Required for PLAYER targets; optional for deterministic/non-exclusive targets. */
  engagementLease?: EngagementLease
}

export interface TargetValidationRequest {
  attackId: string
  attackerId: string
  target: WorldAttackTarget
  now: number
}

export interface AttackPreparationHooks {
  /** Must reserve, not consume, the returned army in the attack-create transaction. */
  reserveArmy(request: ArmyReservationRequest): ArmyReservationGrant
}

export interface AttackTargetValidationHooks {
  /** Must atomically observe plot/version/shield and acquire the defender lease when required. */
  validateAndLockTarget(request: TargetValidationRequest): TargetObservation
}

export interface DirectDamageAbilityEffect {
  kind: 'DIRECT_DAMAGE'
  damage: number
  targetBuildingId?: string
}

export interface DamageBoostAbilityEffect {
  kind: 'DAMAGE_BOOST'
  bonusBasisPoints: number
  durationMs: number
}

export type ResolvedAbilityEffect = DirectDamageAbilityEffect | DamageBoostAbilityEffect

export interface AbilityAuthorization {
  authorizationId: string
  effect: ResolvedAbilityEffect
}

export interface AbilityValidationRequest {
  attackId: string
  attackerId: string
  abilityId: string
  targetBuildingId?: string
  gridX?: number
  gridY?: number
  priorUses: number
}

export interface AttackAbilityValidationHooks {
  /** Converts owned ability inventory into a bounded effect that is persisted in the event. */
  authorizeAbility(request: AbilityValidationRequest): AbilityAuthorization
}

interface AttackCommandBase {
  commandId: string
  /** Starts at one and must be contiguous. The same id+payload is retry-safe. */
  sequence: number
}

export interface DeployTroopCommand extends AttackCommandBase {
  type: 'DEPLOY'
  troopInstanceId: string
  troopType: ReservableTroopType
  gridX: number
  gridY: number
}

export interface UseAbilityCommand extends AttackCommandBase {
  type: 'ABILITY'
  abilityId: string
  targetBuildingId?: string
  gridX?: number
  gridY?: number
}

export interface SurrenderCommand extends AttackCommandBase {
  type: 'SURRENDER'
}

export type AttackCommand = DeployTroopCommand | UseAbilityCommand | SurrenderCommand

interface AttackEventBase {
  eventIndex: number
  /** Milliseconds from first deployment; pre-combat lifecycle events use zero. */
  atMs: number
}

export interface AttackEngagedEvent extends AttackEventBase {
  type: 'ATTACK_ENGAGED'
  leaseId?: string
}

export interface TroopDeployedEvent extends AttackEventBase {
  type: 'TROOP_DEPLOYED'
  commandId: string
  sequence: number
  troopInstanceId: string
  troopType: ReservableTroopType
  /** Fixed-point thousandths of a grid tile. */
  gridXQ: number
  gridYQ: number
}

export interface AbilityUsedEvent extends AttackEventBase {
  type: 'ABILITY_USED'
  commandId: string
  sequence: number
  abilityId: string
  authorizationId: string
  targetBuildingId?: string
  gridXQ?: number
  gridYQ?: number
  effect: ResolvedAbilityEffect
}

export interface AttackSurrenderedEvent extends AttackEventBase {
  type: 'ATTACK_SURRENDERED'
  commandId: string
  sequence: number
}

export type AttackFinalizationReason = 'OBJECTIVE_COMPLETE' | 'SURRENDER' | 'TIMEOUT' | 'ADMIN'

export interface AttackFinalizedEvent extends AttackEventBase {
  type: 'ATTACK_FINALIZED'
  reason: AttackFinalizationReason
  resultHash: string
}

export interface AttackCancelledEvent extends AttackEventBase {
  type: 'ATTACK_CANCELLED'
  reason: string
}

export interface AttackExpiredEvent extends AttackEventBase {
  type: 'ATTACK_EXPIRED'
}

export interface AttackSettledEvent extends AttackEventBase {
  type: 'ATTACK_SETTLED'
  settlementId: string
}

export type AttackEvent =
  | AttackEngagedEvent
  | TroopDeployedEvent
  | AbilityUsedEvent
  | AttackSurrenderedEvent
  | AttackFinalizedEvent
  | AttackCancelledEvent
  | AttackExpiredEvent
  | AttackSettledEvent

export interface AttackCommandReceipt {
  commandId: string
  sequence: number
  commandDigest: string
  appliedVersion: number
  phase: AttackPhase
  eventIndex: number
}

export interface CombatBuildingResult {
  id: string
  remainingHitPoints: number
  destroyed: boolean
}

export interface DeterministicCombatResult {
  simulationVersion: number
  durationMs: number
  destruction: number
  victory: boolean
  damageDealt: number
  totalHitPoints: number
  buildings: CombatBuildingResult[]
  destroyedBuildingIds: string[]
  loot: ResourceAmounts
  requestedTrophyDelta: number
  resultHash: string
}

export interface SettlementParticipantDelta {
  playerId: string
  resources: ResourceAmounts
  requestedTrophyDelta: number
}

export interface AttackSettlementPlan {
  schemaVersion: 1
  settlementId: string
  attackId: string
  resultHash: string
  targetKind: WorldAttackTarget['kind']
  reservationId: string
  consumeArmy: TroopCounts
  releaseArmy: TroopCounts
  attacker: SettlementParticipantDelta
  defender?: SettlementParticipantDelta & {
    shieldUntilAtLeast: number
    revengeAgainstPlayerId: string
  }
  /** PLAYER transfers, BOT mints a bounded faucet, SCENARIO has no economy effect. */
  resourceMode: 'TRANSFER' | 'MINT' | 'NONE'
}

export interface AppliedSettlementOutcome {
  loot: ResourceAmounts
  trophyDelta: number
  consumedArmy: TroopCounts
}

export interface AttackSettlementReceipt {
  settlementId: string
  transactionId: string
  resultHash: string
  committedAt: number
  applied: AppliedSettlementOutcome
}

export interface AttackFinalization {
  reason: AttackFinalizationReason
  result: DeterministicCombatResult
  settlement: AttackSettlementPlan
  receipt?: AttackSettlementReceipt
}

export interface AttackTimestamps {
  createdAt: number
  phaseChangedAt: number
  expiresAt: number
  engagedAt?: number
  combatStartedAt?: number
  finalizedAt?: number
  settledAt?: number
  cancelledAt?: number
  expiredAt?: number
}

/** JSON-safe aggregate. Persistence must CAS both phase and version. */
export interface AttackAggregate {
  schemaVersion: 1
  attackId: string
  attackerId: string
  attackerName: string
  selectionSource: AttackSelectionSource
  phase: AttackPhase
  version: number
  target: WorldAttackTarget
  snapshot: CombatVillageSnapshot
  simulationSeed: string
  rewardPolicy: AttackRewardPolicy
  rules: AttackRulesSnapshot
  reservation: ArmyReservation
  engagement?: EngagementLease
  timestamps: AttackTimestamps
  lastCommandSequence: number
  commandReceipts: Record<string, AttackCommandReceipt>
  events: AttackEvent[]
  finalization?: AttackFinalization
}

export interface PrepareAttackInput {
  attackId: string
  attackerId: string
  attackerName: string
  selectionSource: AttackSelectionSource
  target: WorldAttackTarget
  snapshot: CombatVillageSnapshot
  simulationSeed: string
  rewardPolicy: AttackRewardPolicy
  requestedArmy: TroopCounts
  troopLevel: number
  now: number
  rules?: Partial<AttackRulesSnapshot>
}

export interface ApplyAttackCommandResult {
  attack: AttackAggregate
  receipt: AttackCommandReceipt
  duplicate: boolean
}

export interface CompactAttackReplay {
  schemaVersion: 1
  simulationVersion: number
  attackId: string
  attackerId: string
  attackerName: string
  target: WorldAttackTarget
  snapshot: { snapshotId: string; snapshotHash: string; villageVersion: string }
  troopLevel: number
  simulationSeed: string
  phase: AttackPhase
  events: AttackEvent[]
  result?: Omit<DeterministicCombatResult, 'loot' | 'requestedTrophyDelta'> & {
    loot?: ResourceAmounts
    requestedTrophyDelta?: number
  }
}
