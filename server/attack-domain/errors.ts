export type AttackDomainErrorCode =
  | 'INVALID_INPUT'
  | 'CAS_MISMATCH'
  | 'INVALID_TRANSITION'
  | 'ATTACK_EXPIRED'
  | 'TARGET_UNAVAILABLE'
  | 'TARGET_MOVED'
  | 'TARGET_VERSION_CHANGED'
  | 'TARGET_SHIELDED'
  | 'TARGET_LOCK_REQUIRED'
  | 'ARMY_EMPTY'
  | 'ARMY_RESERVATION_INVALID'
  | 'COMMAND_ID_REUSED'
  | 'COMMAND_SEQUENCE_GAP'
  | 'COMMAND_SEQUENCE_REPLAY'
  | 'COMMAND_LIMIT_REACHED'
  | 'DEPLOYMENT_LIMIT_REACHED'
  | 'TROOP_NOT_RESERVED'
  | 'TROOP_INSTANCE_REUSED'
  | 'ABILITY_NOT_AUTHORIZED'
  | 'SETTLEMENT_MISMATCH'
  | 'INVARIANT_VIOLATION'

export class AttackDomainError extends Error {
  readonly code: AttackDomainErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: AttackDomainErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'AttackDomainError'
    this.code = code
    this.details = details
  }
}

export function attackInvariant(condition: unknown, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new AttackDomainError('INVARIANT_VIOLATION', message, details)
}
