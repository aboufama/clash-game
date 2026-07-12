import { isDeepStrictEqual } from 'node:util'
import {
  ATTACK_TRANSITIONS,
  assertAttackInvariants
} from '../attack-domain/domain'
import type {
  AttackAggregate,
  AttackEvent,
  AttackPhase
} from '../attack-domain/types'
import type {
  AttackCommandRecord,
  AttackRecord,
  AttackState,
  JsonObject
} from './model'

const STATE_BY_PHASE: Readonly<Record<AttackPhase, AttackState>> = Object.freeze({
  PREPARING: 'preparing',
  ENGAGED: 'engaged',
  ACTIVE: 'active',
  FINALIZING: 'finalizing',
  SETTLED: 'settled',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired'
})

type AuthorityProjection = Pick<
  AttackRecord,
  | 'state'
  | 'stateVersion'
  | 'simulationVersion'
  | 'seed'
  | 'defenderSnapshot'
  | 'reservedArmy'
  | 'engagedAt'
  | 'updatedAt'
  | 'deadlineAt'
  | 'endedAt'
  | 'result'
  | 'authority'
>

export interface NewAttackRecordOptions {
  fencingTokenHash: string
  /** Required for non-player targets whose generator fence is not numeric. */
  targetPlotVersion?: number
  updatedAt?: Date
}

function jsonObject(value: object): JsonObject {
  return structuredClone(value) as unknown as JsonObject
}

function dateAt(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value)
}

function terminalTime(authority: AttackAggregate): number | undefined {
  if (authority.phase === 'SETTLED') return authority.timestamps.settledAt
  if (authority.phase === 'CANCELLED') return authority.timestamps.cancelledAt
  if (authority.phase === 'EXPIRED') return authority.timestamps.expiredAt
  return undefined
}

export function attackStateForPhase(phase: AttackPhase): AttackState {
  return STATE_BY_PHASE[phase]
}

export function attackAuthorityProjection(
  authority: AttackAggregate,
  updatedAt: Date
): AuthorityProjection {
  assertAttackInvariants(authority)
  if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) {
    throw new TypeError('Attack authority updatedAt must be a valid Date')
  }
  if (updatedAt.getTime() < authority.timestamps.phaseChangedAt) {
    throw new Error('Attack authority updatedAt cannot predate its current phase')
  }
  return {
    state: attackStateForPhase(authority.phase),
    stateVersion: authority.version,
    simulationVersion: authority.rules.simulationVersion,
    seed: authority.simulationSeed,
    defenderSnapshot: jsonObject(authority.snapshot),
    reservedArmy: jsonObject(authority.reservation),
    engagedAt: dateAt(authority.timestamps.engagedAt),
    updatedAt: new Date(updatedAt),
    deadlineAt: new Date(authority.timestamps.expiresAt),
    endedAt: dateAt(terminalTime(authority)),
    result: authority.finalization ? jsonObject(authority.finalization.result) : null,
    authority: structuredClone(authority)
  }
}

/** Build a new normalized attack row without asking callers to duplicate projections. */
export function attackRecordFromAuthority(
  authority: AttackAggregate,
  options: NewAttackRecordOptions
): AttackRecord {
  const numericPlayerFence = authority.target.kind === 'PLAYER'
    ? Number(authority.target.plot.version)
    : options.targetPlotVersion ?? 1
  if (!Number.isSafeInteger(numericPlayerFence) || numericPlayerFence < 1) {
    throw new Error('Attack target plot version must be a positive safe integer')
  }
  if (!options.fencingTokenHash) throw new Error('Attack fencing token hash is required')
  const updatedAt = options.updatedAt ?? new Date(authority.timestamps.phaseChangedAt)
  const projection = attackAuthorityProjection(authority, updatedAt)
  const record: AttackRecord = {
    id: authority.attackId,
    attackerId: authority.attackerId,
    defenderId: authority.target.kind === 'PLAYER' ? authority.target.playerId : null,
    targetKind: authority.target.kind.toLowerCase() as AttackRecord['targetKind'],
    targetId: authority.target.targetId,
    worldId: authority.target.plot.worldId,
    targetX: authority.target.plot.x,
    targetY: authority.target.plot.y,
    targetPlotVersion: numericPlayerFence,
    fencingTokenHash: options.fencingTokenHash,
    createdAt: new Date(authority.timestamps.createdAt),
    ...projection
  }
  assertAttackRecordAuthority(record)
  return record
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(message)
}

/** Validate the JSON authority against every immutable/queryable relational field. */
export function assertAttackRecordAuthority(record: AttackRecord): void {
  const authority = record.authority
  if (!authority) {
    if (record.state !== 'settled' && record.state !== 'cancelled' && record.state !== 'expired') {
      throw new Error('A resumable attack must contain its complete authority aggregate')
    }
    return
  }
  assertAttackInvariants(authority)
  const targetKind = authority.target.kind.toLowerCase()
  if (record.id !== authority.attackId || record.attackerId !== authority.attackerId) {
    throw new Error('Attack authority identity does not match its relational record')
  }
  if (record.targetKind !== targetKind || record.targetId !== authority.target.targetId) {
    throw new Error('Attack authority target does not match its relational record')
  }
  if (record.worldId !== authority.target.plot.worldId
    || record.targetX !== authority.target.plot.x
    || record.targetY !== authority.target.plot.y) {
    throw new Error('Attack authority plot does not match its relational record')
  }
  if (authority.target.kind === 'PLAYER') {
    if (record.defenderId !== authority.target.playerId
      || String(record.targetPlotVersion) !== authority.target.plot.version) {
      throw new Error('Player attack authority fencing data does not match its relational record')
    }
  } else if (record.defenderId !== null) {
    throw new Error('Non-player attack authority cannot have a defender account')
  }
  if (record.createdAt.getTime() !== authority.timestamps.createdAt) {
    throw new Error('Attack authority creation time does not match its relational record')
  }
  const projection = attackAuthorityProjection(authority, record.updatedAt)
  for (const key of [
    'state',
    'stateVersion',
    'simulationVersion',
    'seed',
    'defenderSnapshot',
    'reservedArmy',
    'engagedAt',
    'deadlineAt',
    'endedAt',
    'result'
  ] as const) {
    assertEqual(record[key], projection[key], `Attack authority projection drifted at ${key}`)
  }
}

const IMMUTABLE_AUTHORITY_FIELDS = [
  'schemaVersion',
  'attackId',
  'attackerId',
  'attackerName',
  'selectionSource',
  'target',
  'snapshot',
  'simulationSeed',
  'rewardPolicy',
  'rules'
] as const

/** Refuse history rewrites even when a caller supplies the correct CAS token. */
export function assertAttackAuthorityReplacement(
  current: AttackAggregate,
  next: AttackAggregate
): void {
  assertAttackInvariants(current)
  assertAttackInvariants(next)
  if (next.version !== current.version + 1) {
    throw new Error('Attack authority replacement must advance exactly one version')
  }
  if (next.phase !== current.phase && !ATTACK_TRANSITIONS[current.phase].includes(next.phase)) {
    throw new Error(`Attack authority cannot transition ${current.phase} -> ${next.phase}`)
  }
  if (next.phase === current.phase) {
    assertEqual(next.timestamps.phaseChangedAt, current.timestamps.phaseChangedAt, 'Same-phase authority update rewrote phaseChangedAt')
  } else if (next.timestamps.phaseChangedAt < current.timestamps.phaseChangedAt) {
    throw new Error('Attack authority phase time moved backwards')
  }
  for (const field of IMMUTABLE_AUTHORITY_FIELDS) {
    assertEqual(next[field], current[field], `Attack authority rewrote immutable ${field}`)
  }
  for (const field of ['reservationId', 'sourceArmyVersion', 'reserved', 'troopLevel'] as const) {
    assertEqual(next.reservation[field], current.reservation[field], `Attack authority rewrote reservation ${field}`)
  }
  for (const [type, deployed] of Object.entries(current.reservation.deployed)) {
    if ((next.reservation.deployed[type as keyof typeof next.reservation.deployed] ?? 0) < (deployed ?? 0)) {
      throw new Error(`Attack authority reduced deployed ${type}`)
    }
  }
  assertEqual(
    next.events.slice(0, current.events.length),
    current.events,
    'Attack authority rewrote its event history'
  )
  for (const [commandId, receipt] of Object.entries(current.commandReceipts)) {
    assertEqual(next.commandReceipts[commandId], receipt, 'Attack authority rewrote a command receipt')
  }
  for (const [field, value] of Object.entries(current.timestamps)) {
    if (field === 'phaseChangedAt' || field === 'expiresAt') continue
    assertEqual(next.timestamps[field as keyof typeof next.timestamps], value, `Attack authority rewrote timestamp ${field}`)
  }
  if (current.finalization) {
    if (!next.finalization) throw new Error('Attack authority removed its finalization')
    for (const field of ['reason', 'result', 'settlement'] as const) {
      assertEqual(next.finalization[field], current.finalization[field], `Attack authority rewrote finalization ${field}`)
    }
    if (current.finalization.receipt) {
      assertEqual(next.finalization.receipt, current.finalization.receipt, 'Attack authority rewrote its settlement receipt')
    }
  }
}

/** Attach an aggregate and regenerate every denormalized attack query field. */
export function attackRecordWithAuthority(
  record: AttackRecord,
  authority: AttackAggregate,
  updatedAt: Date,
  options: { replacing?: boolean } = {}
): AttackRecord {
  if (options.replacing) {
    if (!record.authority) throw new Error('Legacy attacks without authority are immutable')
    if (updatedAt.getTime() < record.updatedAt.getTime()) throw new Error('Attack authority updatedAt moved backwards')
    assertAttackAuthorityReplacement(record.authority, authority)
  }
  const next = {
    ...record,
    ...attackAuthorityProjection(authority, updatedAt)
  }
  assertAttackRecordAuthority(next)
  return next
}

function commandEvent(authority: AttackAggregate, commandId: string): AttackEvent | undefined {
  return authority.events.find(event => 'commandId' in event && event.commandId === commandId)
}

function commandType(event: AttackEvent): string {
  if (event.type === 'TROOP_DEPLOYED') return 'DEPLOY'
  if (event.type === 'ABILITY_USED') return 'ABILITY'
  if (event.type === 'ATTACK_SURRENDERED') return 'SURRENDER'
  throw new Error(`Event ${event.type} is not an attack command`)
}

function commandPayload(event: AttackEvent): JsonObject {
  if (event.type === 'TROOP_DEPLOYED') {
    return {
      commandId: event.commandId,
      sequence: event.sequence,
      type: 'DEPLOY',
      troopInstanceId: event.troopInstanceId,
      troopType: event.troopType,
      gridX: event.gridXQ / 1_000,
      gridY: event.gridYQ / 1_000
    }
  }
  if (event.type === 'ABILITY_USED') {
    return {
      commandId: event.commandId,
      sequence: event.sequence,
      type: 'ABILITY',
      abilityId: event.abilityId,
      ...(event.targetBuildingId ? { targetBuildingId: event.targetBuildingId } : {}),
      ...(event.gridXQ === undefined ? {} : { gridX: event.gridXQ / 1_000, gridY: (event.gridYQ ?? 0) / 1_000 }),
      authorizationId: event.authorizationId,
      effect: jsonObject(event.effect)
    }
  }
  if (event.type === 'ATTACK_SURRENDERED') {
    return { commandId: event.commandId, sequence: event.sequence, type: 'SURRENDER' }
  }
  throw new Error(`Event ${event.type} is not an attack command`)
}

/** Rebuild the normalized audit rows carried redundantly by a legacy aggregate. */
export function attackCommandsFromAuthority(authority: AttackAggregate): AttackCommandRecord[] {
  assertAttackInvariants(authority)
  const baseTime = authority.timestamps.combatStartedAt
    ?? authority.timestamps.engagedAt
    ?? authority.timestamps.createdAt
  return Object.values(authority.commandReceipts)
    .sort((left, right) => left.sequence - right.sequence)
    .map(receipt => {
      const event = commandEvent(authority, receipt.commandId)
      if (!event) throw new Error(`Attack authority has no event for command ${receipt.commandId}`)
      return {
        attackId: authority.attackId,
        sequence: receipt.sequence,
        actorId: authority.attackerId,
        commandId: receipt.commandId,
        commandType: commandType(event),
        payload: commandPayload(event),
        acceptedAt: new Date(baseTime + event.atMs)
      }
    })
}

export function assertAuthorityCommand(
  command: AttackCommandRecord,
  authority: AttackAggregate
): void {
  if (command.attackId !== authority.attackId) throw new Error('Command belongs to another attack')
  const receipt = authority.commandReceipts[command.commandId]
  if (!receipt || receipt.sequence !== command.sequence) {
    throw new Error('Command is not represented by the resulting attack authority')
  }
  const event = commandEvent(authority, command.commandId)
  if (!event || commandType(event) !== command.commandType) {
    throw new Error('Command type differs from the resulting attack authority')
  }
  assertEqual(command.payload, commandPayload(event), 'Command payload differs from the resulting attack authority')
}
