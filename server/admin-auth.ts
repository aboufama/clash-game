import { createHash, createHmac, randomBytes as cryptoRandomBytes, timingSafeEqual } from 'node:crypto'

export const ADMIN_SESSION_COOKIE_NAME = 'clash_admin_session'
export const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1_000
export const ADMIN_LOGIN_WINDOW_MS = 10 * 60 * 1_000
export const ADMIN_LOGIN_FAILURE_LIMIT = 5

const SESSION_VERSION = 1
const MAX_COOKIE_HEADER_LENGTH = 16_384
const MAX_CREDENTIAL_LENGTH = 4_096
const DEFAULT_MAX_RATE_LIMIT_ENTRIES = 4_096
const RATE_LIMIT_SWEEP_INTERVAL_MS = 60_000
const COOKIE_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export interface AdminSession {
  username: string
  issuedAt: number
  expiresAt: number
  csrfToken: string
}

interface SignedAdminSessionPayload {
  v: typeof SESSION_VERSION
  sub: string
  iat: number
  exp: number
  csrf: string
}

export interface AdminSetCookieInstruction {
  headerName: 'Set-Cookie'
  headerValue: string
}

export type AdminLoginResult =
  | {
      ok: true
      status: 200
      session: AdminSession
      setCookie: AdminSetCookieInstruction
    }
  | {
      ok: false
      status: 401
      code: 'INVALID_CREDENTIALS'
      remainingAttempts: number
    }
  | {
      ok: false
      status: 429
      code: 'LOGIN_RATE_LIMITED'
      retryAfterSeconds: number
    }
  | {
      ok: false
      status: 503
      code: 'ADMIN_AUTH_UNAVAILABLE'
    }

export type AdminMutationAuthorization =
  | { ok: true; session: AdminSession }
  | { ok: false; status: 401; code: 'ADMIN_SESSION_REQUIRED' }
  | { ok: false; status: 403; code: 'ADMIN_CSRF_INVALID' }

export interface AdminAuthOptions {
  /** Defaults to process.env. Secrets remain captured in the returned closure. */
  env?: Readonly<Record<string, string | undefined>>
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
  production?: boolean
  cookieName?: string
  throttle?: AdminLoginThrottle
  rateLimitMaximumEntries?: number
}

export interface AdminLoginInput {
  username: unknown
  password: unknown
  clientAddress?: unknown
}

export interface AdminAuth {
  readonly configured: boolean
  readonly username: string
  login(input: AdminLoginInput): AdminLoginResult
  session(cookieHeader: string | readonly string[] | null | undefined): AdminSession | null
  authorizeMutation(
    cookieHeader: string | readonly string[] | null | undefined,
    csrfToken: unknown
  ): AdminMutationAuthorization
  logout(): { status: 204; setCookie: AdminSetCookieInstruction }
  cleanupRateLimits(): void
}

interface RateLimitDecision {
  allowed: boolean
  failureCount: number
  retryAfterMs: number
}

function safeNow(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function normalizeClientAddress(value: unknown): string {
  const header = typeof value === 'string' ? value : 'unknown'
  // Vercel supplies a comma-separated X-Forwarded-For chain with the client first.
  const first = header.split(',', 1)[0]?.trim().toLowerCase() || 'unknown'
  return first.slice(0, 256)
}

function rateLimitKey(value: unknown): string {
  return createHash('sha256').update(normalizeClientAddress(value), 'utf8').digest('base64url')
}

/**
 * A bounded, process-local abuse brake. Stateless admin sessions work across
 * Vercel instances; this limiter deliberately fails closed through a shared
 * overflow bucket when its fixed memory budget is exhausted.
 */
export class AdminLoginThrottle {
  private readonly failures = new Map<string, number[]>()
  private overflowFailures: number[] = []
  private nextSweepAt = 0

  readonly failureLimit: number
  readonly windowMs: number
  readonly maximumEntries: number

  constructor(options: {
    failureLimit?: number
    windowMs?: number
    maximumEntries?: number
  } = {}) {
    this.failureLimit = Math.max(1, Math.floor(options.failureLimit ?? ADMIN_LOGIN_FAILURE_LIMIT))
    this.windowMs = Math.max(1, Math.floor(options.windowMs ?? ADMIN_LOGIN_WINDOW_MS))
    this.maximumEntries = Math.max(1, Math.floor(options.maximumEntries ?? DEFAULT_MAX_RATE_LIMIT_ENTRIES))
  }

  get entryCount(): number {
    return this.failures.size + (this.overflowFailures.length > 0 ? 1 : 0)
  }

  cleanup(now: number): void {
    this.sweep(safeNow(now), true)
  }

  check(clientAddress: unknown, now: number): RateLimitDecision {
    const at = safeNow(now)
    this.sweep(at)
    const key = rateLimitKey(clientAddress)
    const failures = this.currentFailures(key, at)
    if (failures.length < this.failureLimit) {
      return { allowed: true, failureCount: failures.length, retryAfterMs: 0 }
    }
    return {
      allowed: false,
      failureCount: failures.length,
      retryAfterMs: Math.max(1, this.windowMs - (at - failures[0]))
    }
  }

  recordFailure(clientAddress: unknown, now: number): RateLimitDecision {
    const at = safeNow(now)
    this.sweep(at)
    const key = rateLimitKey(clientAddress)
    let failures = this.failures.get(key)
    if (!failures) {
      if (this.overflowFailures.length > 0) {
        failures = this.overflowFailures
      } else if (this.failures.size < this.maximumEntries) {
        failures = []
        this.failures.set(key, failures)
      } else {
        failures = this.overflowFailures
      }
    }
    this.prune(failures, at)
    // Once blocked, additional timestamps add no information and must not grow memory.
    if (failures.length < this.failureLimit) failures.push(at)
    return {
      allowed: failures.length < this.failureLimit,
      failureCount: failures.length,
      retryAfterMs: failures.length < this.failureLimit
        ? 0
        : Math.max(1, this.windowMs - (at - failures[0]))
    }
  }

  recordSuccess(clientAddress: unknown): void {
    // Do not clear the shared overflow bucket on one successful login.
    this.failures.delete(rateLimitKey(clientAddress))
  }

  private currentFailures(key: string, now: number): number[] {
    const own = this.failures.get(key)
    if (own) {
      this.prune(own, now)
      if (own.length === 0) this.failures.delete(key)
      return own
    }
    if (this.overflowFailures.length > 0 || this.failures.size >= this.maximumEntries) {
      this.prune(this.overflowFailures, now)
      return this.overflowFailures
    }
    return []
  }

  private prune(failures: number[], now: number): void {
    const cutoff = now - this.windowMs
    let firstLive = 0
    while (firstLive < failures.length && failures[firstLive] <= cutoff) firstLive += 1
    if (firstLive > 0) failures.splice(0, firstLive)
  }

  private sweep(now: number, force = false): void {
    if (!force && now < this.nextSweepAt) return
    this.nextSweepAt = now + RATE_LIMIT_SWEEP_INTERVAL_MS
    for (const [key, failures] of this.failures) {
      this.prune(failures, now)
      if (failures.length === 0) this.failures.delete(key)
    }
    this.prune(this.overflowFailures, now)
    if (this.overflowFailures.length === 0) this.overflowFailures = []
  }
}

function credentialText(value: unknown): { text: string; valid: boolean } {
  if (typeof value !== 'string' || value.length > MAX_CREDENTIAL_LENGTH) {
    return { text: '\u0000', valid: false }
  }
  return { text: value, valid: true }
}

function constantTimeTextEqual(actual: unknown, expected: string): boolean {
  const candidate = credentialText(actual)
  const actualDigest = createHash('sha256').update(candidate.text, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(actualDigest, expectedDigest) && candidate.valid
}

function serializeCookie(
  name: string,
  value: string,
  options: { expiresAt: number; maxAgeSeconds: number; secure: boolean }
): AdminSetCookieInstruction {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
    `Expires=${new Date(options.expiresAt).toUTCString()}`
  ]
  if (options.secure) attributes.push('Secure')
  return { headerName: 'Set-Cookie', headerValue: attributes.join('; ') }
}

/** Parse Cookie request headers without using an object/prototype keyspace. */
export function parseAdminCookies(
  header: string | readonly string[] | null | undefined
): ReadonlyMap<string, string> {
  const combined = Array.isArray(header) ? header.join(';') : header
  const result = new Map<string, string>()
  if (typeof combined !== 'string' || combined.length > MAX_COOKIE_HEADER_LENGTH) return result
  const invalidDuplicates = new Set<string>()
  for (const part of combined.split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    if (!COOKIE_NAME_PATTERN.test(name) || invalidDuplicates.has(name)) continue
    let rawValue = part.slice(separator + 1).trim()
    if (rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')) {
      rawValue = rawValue.slice(1, -1).replace(/\\(.)/g, '$1')
    }
    let value = rawValue
    try {
      value = decodeURIComponent(rawValue)
    } catch {
      // Retain malformed percent-encoding; signed-token validation rejects it.
    }
    const previous = result.get(name)
    if (previous !== undefined && previous !== value) {
      result.delete(name)
      invalidDuplicates.add(name)
      continue
    }
    result.set(name, value)
  }
  return result
}

function isSignedPayload(value: unknown): value is SignedAdminSessionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Partial<SignedAdminSessionPayload>
  return payload.v === SESSION_VERSION &&
    typeof payload.sub === 'string' &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp) &&
    typeof payload.csrf === 'string' &&
    payload.csrf.length === 43 &&
    BASE64URL_PATTERN.test(payload.csrf)
}

function sessionFromPayload(payload: SignedAdminSessionPayload): AdminSession {
  return {
    username: payload.sub,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
    csrfToken: payload.csrf
  }
}

/**
 * Creates an isolated admin authentication service. A password and stable
 * signing secret are mandatory; without either, every authentication attempt
 * fails closed and no session can be minted or accepted.
 */
export function createAdminAuth(options: AdminAuthOptions = {}): AdminAuth {
  const env = options.env ?? process.env
  const username = env.CLASH_ADMIN_USERNAME?.trim() || 'admin'
  const password = env.CLASH_ADMIN_PASSWORD
  const sessionSecret = env.CLASH_ADMIN_SESSION_SECRET
  const configured = typeof password === 'string' && password.length > 0 &&
    typeof sessionSecret === 'string' && sessionSecret.length > 0
  const production = options.production ?? (env.NODE_ENV === 'production' || env.VERCEL === '1')
  const cookieName = options.cookieName && COOKIE_NAME_PATTERN.test(options.cookieName)
    ? options.cookieName
    : ADMIN_SESSION_COOKIE_NAME
  const now = options.now ?? Date.now
  const randomBytes = options.randomBytes ?? cryptoRandomBytes
  const throttle = options.throttle ?? new AdminLoginThrottle({
    maximumEntries: options.rateLimitMaximumEntries
  })
  // Dummy values keep the comparison path structurally identical when disabled.
  const expectedPassword = configured ? password : '\u0000-disabled-password'
  const signingSecret = configured ? sessionSecret : '\u0000-disabled-session-secret'

  function sign(encodedPayload: string): Buffer {
    return createHmac('sha256', signingSecret).update(`admin-session-v1.${encodedPayload}`, 'utf8').digest()
  }

  function mintSession(at: number): { session: AdminSession; token: string } {
    const csrfBytes = Buffer.from(randomBytes(32))
    if (csrfBytes.length !== 32) throw new Error('Admin CSRF entropy source returned an invalid byte count')
    const payload: SignedAdminSessionPayload = {
      v: SESSION_VERSION,
      sub: username,
      iat: at,
      exp: at + ADMIN_SESSION_TTL_MS,
      csrf: csrfBytes.toString('base64url')
    }
    const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    return {
      session: sessionFromPayload(payload),
      token: `${encodedPayload}.${sign(encodedPayload).toString('base64url')}`
    }
  }

  function verifySessionToken(token: string): AdminSession | null {
    if (!configured || token.length > 4_096) return null
    const segments = token.split('.')
    if (segments.length !== 2) return null
    const [encodedPayload, encodedSignature] = segments
    if (!encodedPayload || !encodedSignature ||
      !BASE64URL_PATTERN.test(encodedPayload) || !BASE64URL_PATTERN.test(encodedSignature)) return null
    let suppliedSignature: Buffer
    try {
      suppliedSignature = Buffer.from(encodedSignature, 'base64url')
    } catch {
      return null
    }
    const expectedSignature = sign(encodedPayload)
    if (suppliedSignature.length !== expectedSignature.length ||
      suppliedSignature.toString('base64url') !== encodedSignature ||
      !timingSafeEqual(suppliedSignature, expectedSignature)) return null
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'))
    } catch {
      return null
    }
    if (!isSignedPayload(decoded)) return null
    const at = safeNow(now())
    if (!constantTimeTextEqual(decoded.sub, username) ||
      decoded.exp - decoded.iat !== ADMIN_SESSION_TTL_MS ||
      decoded.iat > at + 60_000 ||
      at >= decoded.exp) return null
    return sessionFromPayload(decoded)
  }

  function readSession(cookieHeader: string | readonly string[] | null | undefined): AdminSession | null {
    const token = parseAdminCookies(cookieHeader).get(cookieName)
    return token ? verifySessionToken(token) : null
  }

  return {
    configured,
    username,

    login(input): AdminLoginResult {
      const at = safeNow(now())
      // Both comparisons always run, including when the module is disabled.
      const usernameMatches = constantTimeTextEqual(input.username, username)
      const passwordMatches = constantTimeTextEqual(input.password, expectedPassword)
      if (!configured) return { ok: false, status: 503, code: 'ADMIN_AUTH_UNAVAILABLE' }

      const allowed = throttle.check(input.clientAddress, at)
      if (!allowed.allowed) {
        return {
          ok: false,
          status: 429,
          code: 'LOGIN_RATE_LIMITED',
          retryAfterSeconds: Math.max(1, Math.ceil(allowed.retryAfterMs / 1_000))
        }
      }
      if (!usernameMatches || !passwordMatches) {
        const failure = throttle.recordFailure(input.clientAddress, at)
        return {
          ok: false,
          status: 401,
          code: 'INVALID_CREDENTIALS',
          remainingAttempts: Math.max(0, throttle.failureLimit - failure.failureCount)
        }
      }

      throttle.recordSuccess(input.clientAddress)
      const minted = mintSession(at)
      return {
        ok: true,
        status: 200,
        session: minted.session,
        setCookie: serializeCookie(cookieName, minted.token, {
          expiresAt: minted.session.expiresAt,
          maxAgeSeconds: ADMIN_SESSION_TTL_MS / 1_000,
          secure: production
        })
      }
    },

    session(cookieHeader): AdminSession | null {
      return readSession(cookieHeader)
    },

    authorizeMutation(cookieHeader, csrfToken): AdminMutationAuthorization {
      const authenticated = readSession(cookieHeader)
      if (!authenticated) {
        return { ok: false, status: 401, code: 'ADMIN_SESSION_REQUIRED' }
      }
      if (!constantTimeTextEqual(csrfToken, authenticated.csrfToken)) {
        return { ok: false, status: 403, code: 'ADMIN_CSRF_INVALID' }
      }
      return { ok: true, session: authenticated }
    },

    logout(): { status: 204; setCookie: AdminSetCookieInstruction } {
      return {
        status: 204,
        setCookie: serializeCookie(cookieName, '', {
          expiresAt: 0,
          maxAgeSeconds: 0,
          secure: production
        })
      }
    },

    cleanupRateLimits(): void {
      throttle.cleanup(safeNow(now()))
    }
  }
}
