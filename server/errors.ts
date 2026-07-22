/** HTTP-facing domain failure shared by every application-service runtime. */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: Record<string, unknown>

  constructor(status: number, message: string, code?: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * A newly created player must explicitly choose all banner axes before any
 * gameplay state can be changed. Keep this transport failure identical across
 * the legacy JSON and normalized persistence runtimes.
 */
export function bannerRequiredError(): ApiError {
  return new ApiError(
    409,
    'Choose a village banner before changing your village',
    'BANNER_REQUIRED'
  )
}

/** The battle tutorial precedes even heraldry selection for new accounts. */
export function introBattleRequiredError(): ApiError {
  return new ApiError(
    409,
    'Answer Sir Andre\'s summons before changing your village',
    'INTRO_BATTLE_REQUIRED'
  )
}

/** The first home-base lesson follows Sir Andre and precedes heraldry. */
export function watchtowerPlacementRequiredError(): ApiError {
  return new ApiError(
    409,
    'Place your first Watchtower before changing your village',
    'WATCHTOWER_PLACEMENT_REQUIRED'
  )
}
