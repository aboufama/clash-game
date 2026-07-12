import { randomBytes } from 'node:crypto'
import { hashSessionToken } from './credentials'

export interface SessionTokenIssue {
  token: string
  tokenHash: string
  tokenHashes: string[]
  evictedTokenHashes: string[]
}

export interface SessionTokenIssueOptions {
  maximumSessions: number
  tokenFactory?: () => string
}

export interface SessionTokenRevocation {
  tokenHash: string
  tokenHashes: string[]
  revoked: boolean
}

export function createOpaqueSessionToken(): string {
  return `tok_${randomBytes(24).toString('hex')}`
}

/**
 * Return the next bounded session set without mutating the persistent record.
 * The caller owns updating its token index and committing the returned hashes.
 */
export function issueSessionToken(
  currentTokenHashes: readonly string[],
  options: SessionTokenIssueOptions
): SessionTokenIssue {
  if (!Number.isSafeInteger(options.maximumSessions) || options.maximumSessions < 1) {
    throw new RangeError('maximumSessions must be a positive safe integer')
  }
  const token = (options.tokenFactory ?? createOpaqueSessionToken)()
  if (!token) throw new Error('session token factory returned an empty token')
  const tokenHash = hashSessionToken(token)
  const tokenHashes = [...currentTokenHashes, tokenHash]
  const evictedTokenHashes = tokenHashes.splice(0, Math.max(0, tokenHashes.length - options.maximumSessions))
  return { token, tokenHash, tokenHashes, evictedTokenHashes }
}

export function revokeSessionToken(
  currentTokenHashes: readonly string[],
  rawToken: string
): SessionTokenRevocation {
  const tokenHash = hashSessionToken(rawToken)
  const tokenHashes = currentTokenHashes.filter(existing => existing !== tokenHash)
  return {
    tokenHash,
    tokenHashes,
    revoked: tokenHashes.length !== currentTokenHashes.length
  }
}

/** Normalize the one-token pre-account shape during legacy loading. */
export function migrateLegacyTokenHashes(
  rawTokenHashes: unknown,
  legacyTokenHash: unknown
): string[] {
  const current = Array.isArray(rawTokenHashes)
    ? rawTokenHashes.filter((value): value is string => typeof value === 'string')
    : []
  if (typeof legacyTokenHash === 'string' && legacyTokenHash && !current.includes(legacyTokenHash)) {
    current.push(legacyTokenHash)
  }
  return current
}
