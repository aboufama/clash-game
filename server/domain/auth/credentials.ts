import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'

export interface CredentialPolicy {
  usernamePattern: RegExp
  usernameDescription: string
  minimumPasswordLength: number
  maximumPasswordLength: number
}

export const DEFAULT_CREDENTIAL_POLICY: CredentialPolicy = {
  usernamePattern: /^[a-zA-Z0-9_-]{3,18}$/,
  usernameDescription: 'Username must be 3-18 characters: letters, numbers, "_" or "-"',
  minimumPasswordLength: 8,
  maximumPasswordLength: 128
}

export type CredentialValidation =
  | { ok: true; username: string; password: string }
  | { ok: false; message: string }

export function normalizeUsernameKey(username: string): string {
  return username.trim().toLowerCase()
}

export function isValidUsername(username: string, policy: CredentialPolicy = DEFAULT_CREDENTIAL_POLICY): boolean {
  return policy.usernamePattern.test(username)
}

/** Validate registration input without coupling the auth domain to HTTP errors. */
export function validateRegistrationCredentials(
  rawUsername: unknown,
  rawPassword: unknown,
  policy: CredentialPolicy = DEFAULT_CREDENTIAL_POLICY
): CredentialValidation {
  const username = String(rawUsername ?? '').trim()
  if (!isValidUsername(username, policy)) {
    return { ok: false, message: policy.usernameDescription }
  }
  if (typeof rawPassword !== 'string' || rawPassword.length < policy.minimumPasswordLength) {
    return { ok: false, message: `Password must be at least ${policy.minimumPasswordLength} characters` }
  }
  if (rawPassword.length > policy.maximumPasswordLength) {
    return { ok: false, message: `Password must be at most ${policy.maximumPasswordLength} characters` }
  }
  return { ok: true, username, password: rawPassword }
}

export function normalizeSessionToken(rawToken: unknown): string {
  return typeof rawToken === 'string' ? rawToken.trim() : ''
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Password hashes are self-describing so a future migration can recognize the
 * legacy scrypt format while new registrations move to another KDF.
 */
export function hashPassword(password: string, salt: Uint8Array = randomBytes(16)): string {
  const saltBuffer = Buffer.from(salt)
  const derived = scryptSync(password, saltBuffer, 64)
  return `scrypt:${saltBuffer.toString('hex')}:${derived.toString('hex')}`
}

function derivePasswordAsync(password: string, salt: Uint8Array, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, (error, derived) => {
      if (error) reject(error)
      else resolve(Buffer.from(derived))
    })
  })
}

/** Non-blocking production KDF; preserves the self-describing legacy format. */
export async function hashPasswordAsync(
  password: string,
  salt: Uint8Array = randomBytes(16)
): Promise<string> {
  const saltBuffer = Buffer.from(salt)
  const derived = await derivePasswordAsync(password, saltBuffer, 64)
  return `scrypt:${saltBuffer.toString('hex')}:${derived.toString('hex')}`
}

/** Malformed persisted hashes fail closed instead of crashing a login request. */
export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex, extra] = stored.split(':')
  if (scheme !== 'scrypt' || !saltHex || !hashHex || extra !== undefined) return false
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0) return false
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length % 2 !== 0) return false

  const expected = Buffer.from(hashHex, 'hex')
  if (expected.length === 0 || expected.length > 256) return false
  try {
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Malformed persisted hashes fail closed without blocking the Node event loop. */
export async function verifyPasswordAsync(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex, extra] = stored.split(':')
  if (scheme !== 'scrypt' || !saltHex || !hashHex || extra !== undefined) return false
  if (!/^[0-9a-f]+$/i.test(saltHex) || saltHex.length % 2 !== 0) return false
  if (!/^[0-9a-f]+$/i.test(hashHex) || hashHex.length % 2 !== 0) return false
  const expected = Buffer.from(hashHex, 'hex')
  if (expected.length === 0 || expected.length > 256) return false
  try {
    const actual = await derivePasswordAsync(password, Buffer.from(saltHex, 'hex'), expected.length)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
