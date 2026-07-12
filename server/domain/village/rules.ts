export type VillageRuleFailure = 'INVALID' | 'CONFLICT'

export type VillageRuleCode =
  | 'DUPLICATE_BUILDING_ID'
  | 'DUPLICATE_OBSTACLE_ID'
  | 'MISSING_TOWN_HALL'
  | 'OBSTACLE_MUTATED'
  | 'OBSTACLE_CREATED'
  | 'LAYOUT_COLLISION'
  | 'ARMY_OVER_CAPACITY'
  | 'MIXED_WALL_LEVELS'
  | 'WALL_COHORT_MISMATCH'
  | 'UPGRADE_IN_PROGRESS'
  | 'MULTI_LEVEL_UPGRADE'

/**
 * Transport-neutral village-rule failure. The HTTP application layer decides
 * how INVALID and CONFLICT map onto response status codes.
 */
export class VillageRuleError extends Error {
  readonly failure: VillageRuleFailure
  readonly rule: VillageRuleCode
  readonly clientCode?: string
  readonly details?: Record<string, unknown>

  constructor(
    failure: VillageRuleFailure,
    rule: VillageRuleCode,
    message: string,
    clientCode?: string,
    details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'VillageRuleError'
    this.failure = failure
    this.rule = rule
    this.clientCode = clientCode
    this.details = details
  }
}

