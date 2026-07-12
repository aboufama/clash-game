export interface AuthRateLimitPolicy {
  loginMaximumFailures: number
  loginLockoutMs: number
  loginAddressWindowMs: number
  loginAddressAttemptLimit: number
  guestCreationWindowMs: number
  guestCreationLimit: number
  sweepIntervalMs?: number
}

export type GuestCreationDecision =
  | { allowed: true; address: string }
  | { allowed: false; address: string; reason: 'GUEST_CREATION_LIMIT' }

export type LoginAttemptDecision =
  | { allowed: true; address: string; failureKey: string }
  | { allowed: false; address: string; failureKey: string; reason: 'ADDRESS_LIMIT' | 'CREDENTIAL_LOCK' }

export interface AuthRateLimiter {
  consumeGuestCreation(rawAddress: unknown, now: number): GuestCreationDecision
  beginLogin(rawAddress: unknown, usernameKey: string, now: number): LoginAttemptDecision
  recordLoginFailure(failureKey: string, now: number): void
  recordLoginSuccess(failureKey: string): void
}

interface FailureWindow {
  count: number
  lockedUntil: number
  updatedAt: number
}

interface CountWindow {
  startedAt: number
  count: number
}

export function normalizeClientAddress(rawAddress: unknown): string {
  return String(rawAddress ?? 'unknown').slice(0, 96)
}

/**
 * Process-local abuse brake. Decisions depend only on explicit input and `now`,
 * making the policy deterministic and straightforward to replace with Redis.
 */
export class InMemoryAuthRateLimiter implements AuthRateLimiter {
  private readonly policy: AuthRateLimitPolicy
  private readonly loginFailures = new Map<string, FailureWindow>()
  private readonly loginAddressAttempts = new Map<string, CountWindow>()
  private readonly guestCreations = new Map<string, CountWindow>()
  private nextSweepAt = 0

  constructor(policy: AuthRateLimitPolicy) {
    this.policy = policy
  }

  sweep(now: number): void {
    if (now < this.nextSweepAt) return
    this.nextSweepAt = now + (this.policy.sweepIntervalMs ?? 60_000)
    for (const [key, value] of this.loginFailures) {
      const expired = value.lockedUntil > 0
        ? value.lockedUntil <= now
        : now - value.updatedAt >= this.policy.loginLockoutMs
      if (expired) this.loginFailures.delete(key)
    }
    for (const [address, value] of this.loginAddressAttempts) {
      if (now - value.startedAt >= this.policy.loginAddressWindowMs) this.loginAddressAttempts.delete(address)
    }
    for (const [address, value] of this.guestCreations) {
      if (now - value.startedAt >= this.policy.guestCreationWindowMs) this.guestCreations.delete(address)
    }
  }

  consumeGuestCreation(rawAddress: unknown, now: number): GuestCreationDecision {
    this.sweep(now)
    const address = normalizeClientAddress(rawAddress)
    let window = this.guestCreations.get(address)
    if (!window || now - window.startedAt >= this.policy.guestCreationWindowMs) {
      window = { startedAt: now, count: 0 }
      this.guestCreations.set(address, window)
    }
    if (window.count >= this.policy.guestCreationLimit) {
      return { allowed: false, address, reason: 'GUEST_CREATION_LIMIT' }
    }
    window.count += 1
    return { allowed: true, address }
  }

  beginLogin(rawAddress: unknown, usernameKey: string, now: number): LoginAttemptDecision {
    this.sweep(now)
    const address = normalizeClientAddress(rawAddress)
    const failureKey = `${address}:${usernameKey}`
    let window = this.loginAddressAttempts.get(address)
    if (!window || now - window.startedAt >= this.policy.loginAddressWindowMs) {
      window = { startedAt: now, count: 0 }
      this.loginAddressAttempts.set(address, window)
    }
    if (window.count >= this.policy.loginAddressAttemptLimit) {
      return { allowed: false, address, failureKey, reason: 'ADDRESS_LIMIT' }
    }
    window.count += 1

    const failure = this.loginFailures.get(failureKey)
    if (failure && failure.lockedUntil > now) {
      return { allowed: false, address, failureKey, reason: 'CREDENTIAL_LOCK' }
    }
    return { allowed: true, address, failureKey }
  }

  recordLoginFailure(failureKey: string, now: number): void {
    const previous = this.loginFailures.get(failureKey)
    const next: FailureWindow = {
      count: (previous?.count ?? 0) + 1,
      lockedUntil: 0,
      updatedAt: now
    }
    if (next.count >= this.policy.loginMaximumFailures) {
      next.count = 0
      next.lockedUntil = now + this.policy.loginLockoutMs
    }
    this.loginFailures.set(failureKey, next)
  }

  recordLoginSuccess(failureKey: string): void {
    this.loginFailures.delete(failureKey)
  }
}
