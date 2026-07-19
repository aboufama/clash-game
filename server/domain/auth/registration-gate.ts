/**
 * The registration wall — the ONE shared rule both runtimes (the JSON
 * GameService and the normalized persistence runtime) enforce identically:
 *
 * In production a fresh device gets NO village. `POST /auth/session` without a
 * resumable token answers `{ registrationRequired: true }` instead of minting
 * a guest account + plot; the player must register (username + password) or
 * log in first. Registration itself creates the account AND allocates its
 * plot through the existing allocation path.
 *
 * Guest auto-play is a DEV/HARNESS affordance, opted into with
 * `CLASH_ALLOW_GUESTS=1` (the `npm run dev` script sets it — every
 * art-preview harness and the shared device token rely on it). Existing
 * sessions are grandfathered: a valid token always resumes its account, guest
 * or registered, regardless of this flag — only NEW devices hit the wall.
 */

/** `POST /auth/session` payload when the server declines to mint a guest. */
export interface RegistrationRequiredResponse {
  registrationRequired: true
}

export function registrationRequiredResponse(): RegistrationRequiredResponse {
  return { registrationRequired: true }
}

export function isRegistrationRequired(response: unknown): response is RegistrationRequiredResponse {
  return typeof response === 'object' && response !== null
    && (response as { registrationRequired?: unknown }).registrationRequired === true
}

/**
 * Narrow an `ensureSession` result to the granted-session arm. Test/tooling
 * helper: throws when the registration wall answered instead.
 */
export function grantedSession<T>(response: T | RegistrationRequiredResponse): T {
  if (isRegistrationRequired(response)) {
    throw new Error('Expected a granted session, but the server required registration (set CLASH_ALLOW_GUESTS=1 for guest auto-play)')
  }
  return response
}

/** Production default: registration required. Guests only with the explicit flag. */
export function guestSessionsAllowed(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.CLASH_ALLOW_GUESTS === '1'
}
