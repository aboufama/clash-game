import assert from 'node:assert/strict'
import {
  InMemoryAuthRateLimiter,
  hashPassword,
  hashSessionToken,
  isValidUsername,
  issueSessionToken,
  migrateLegacyTokenHashes,
  normalizeClientAddress,
  normalizeSessionToken,
  normalizeUsernameKey,
  revokeSessionToken,
  validateRegistrationCredentials,
  verifyPassword
} from './index'

const valid = validateRegistrationCredentials('  Chief_7 ', 'long-enough')
assert.deepEqual(valid, { ok: true, username: 'Chief_7', password: 'long-enough' })
assert.equal(validateRegistrationCredentials('x!', 'long-enough').ok, false)
assert.equal(validateRegistrationCredentials('Chief_7', 'short').ok, false)
assert.equal(validateRegistrationCredentials('Chief_7', 'x'.repeat(129)).ok, false)
assert.equal(normalizeUsernameKey('  ChIeF_7 '), 'chief_7')
assert.equal(isValidUsername('Chief_7'), true)
assert.equal(isValidUsername('x!'), false)
assert.equal(normalizeSessionToken('  tok_value  '), 'tok_value')
assert.equal(normalizeSessionToken(42), '')
assert.equal(normalizeClientAddress('x'.repeat(120)).length, 96)

const encoded = hashPassword('correct horse', Uint8Array.from({ length: 16 }, (_, index) => index))
assert.match(encoded, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/)
assert.equal(verifyPassword('correct horse', encoded), true)
assert.equal(verifyPassword('wrong horse', encoded), false)
assert.equal(verifyPassword('correct horse', 'scrypt:not-hex:also-not-hex'), false)
assert.equal(verifyPassword('correct horse', 'bcrypt:salt:hash'), false)
assert.match(hashSessionToken('tok_example'), /^[0-9a-f]{64}$/)

const existing = ['oldest', 'middle'].map(hashSessionToken)
const issued = issueSessionToken(existing, { maximumSessions: 2, tokenFactory: () => 'tok_new' })
assert.equal(issued.token, 'tok_new')
assert.deepEqual(issued.evictedTokenHashes, [existing[0]])
assert.deepEqual(issued.tokenHashes, [existing[1], hashSessionToken('tok_new')])
assert.equal(existing.length, 2, 'session issuance does not mutate the source record')
assert.deepEqual(revokeSessionToken(issued.tokenHashes, 'tok_new'), {
  tokenHash: hashSessionToken('tok_new'),
  tokenHashes: [existing[1]],
  revoked: true
})
assert.deepEqual(migrateLegacyTokenHashes(undefined, 'legacy'), ['legacy'])
assert.deepEqual(migrateLegacyTokenHashes(['current', 'legacy'], 'legacy'), ['current', 'legacy'])
assert.throws(() => issueSessionToken([], { maximumSessions: 0 }), /maximumSessions/)

const limiter = new InMemoryAuthRateLimiter({
  loginMaximumFailures: 2,
  loginLockoutMs: 1_000,
  loginAddressWindowMs: 500,
  loginAddressAttemptLimit: 3,
  guestCreationWindowMs: 500,
  guestCreationLimit: 2,
  sweepIntervalMs: 1
})
assert.equal(limiter.consumeGuestCreation('127.0.0.1', 0).allowed, true)
assert.equal(limiter.consumeGuestCreation('127.0.0.1', 1).allowed, true)
assert.deepEqual(limiter.consumeGuestCreation('127.0.0.1', 2), {
  allowed: false,
  address: '127.0.0.1',
  reason: 'GUEST_CREATION_LIMIT'
})
assert.equal(limiter.consumeGuestCreation('127.0.0.1', 501).allowed, true)

const firstLogin = limiter.beginLogin('10.0.0.1', 'chief', 0)
assert.equal(firstLogin.allowed, true)
limiter.recordLoginFailure(firstLogin.failureKey, 0)
const secondLogin = limiter.beginLogin('10.0.0.1', 'chief', 1)
assert.equal(secondLogin.allowed, true)
limiter.recordLoginFailure(secondLogin.failureKey, 1)
const lockedLogin = limiter.beginLogin('10.0.0.1', 'chief', 2)
assert.equal(lockedLogin.allowed ? undefined : lockedLogin.reason, 'CREDENTIAL_LOCK')
const addressLimitedLogin = limiter.beginLogin('10.0.0.1', 'other', 3)
assert.equal(addressLimitedLogin.allowed ? undefined : addressLimitedLogin.reason, 'ADDRESS_LIMIT')
assert.equal(limiter.beginLogin('10.0.0.2', 'chief', 3).allowed, true)
assert.equal(limiter.beginLogin('10.0.0.1', 'chief', 1_002).allowed, true)
limiter.recordLoginSuccess('10.0.0.1:chief')

console.log('auth domain: credential, session, and rate-limit checks passed')
