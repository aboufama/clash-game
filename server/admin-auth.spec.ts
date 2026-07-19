import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ADMIN_LOGIN_WINDOW_MS,
  ADMIN_SESSION_COOKIE_NAME,
  ADMIN_SESSION_TTL_MS,
  AdminLoginThrottle,
  createAdminAuth,
  parseAdminCookies
} from './admin-auth'

const TEST_ENV = {
  CLASH_ADMIN_USERNAME: 'admin',
  CLASH_ADMIN_PASSWORD: 'test-only-password',
  CLASH_ADMIN_SESSION_SECRET: 'test-only-session-secret-with-stable-entropy'
} as const

function deterministicBytes(size: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 17 + 9) & 0xff)
}

function cookieRequestHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0]
}

test('missing password or signing secret fails closed', () => {
  const missingPassword = createAdminAuth({
    env: { CLASH_ADMIN_SESSION_SECRET: 'present' },
    now: () => 0,
    randomBytes: deterministicBytes
  })
  assert.equal(missingPassword.configured, false)
  assert.deepEqual(missingPassword.login({ username: 'admin', password: '', clientAddress: '1.1.1.1' }), {
    ok: false,
    status: 503,
    code: 'ADMIN_AUTH_UNAVAILABLE'
  })

  const missingSecret = createAdminAuth({
    env: { CLASH_ADMIN_PASSWORD: 'anything' },
    now: () => 0,
    randomBytes: deterministicBytes
  })
  assert.equal(missingSecret.configured, false)
  assert.equal(missingSecret.session(`${ADMIN_SESSION_COOKIE_NAME}=forged.value`), null)
})

test('valid credentials issue an eight-hour stateless session with strict cookie flags', () => {
  let clock = 1_700_000_000_000
  const auth = createAdminAuth({
    env: TEST_ENV,
    production: true,
    now: () => clock,
    randomBytes: deterministicBytes
  })
  const login = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '203.0.113.7' })
  assert.equal(login.ok, true)
  if (!login.ok) return
  assert.equal(login.session.expiresAt - login.session.issuedAt, ADMIN_SESSION_TTL_MS)
  assert.equal(login.setCookie.headerName, 'Set-Cookie')
  assert.match(login.setCookie.headerValue, /^clash_admin_session=[A-Za-z0-9_.-]+;/)
  assert.match(login.setCookie.headerValue, /; Path=\//)
  assert.match(login.setCookie.headerValue, /; HttpOnly/)
  assert.match(login.setCookie.headerValue, /; SameSite=Strict/)
  assert.match(login.setCookie.headerValue, /; Max-Age=28800/)
  assert.match(login.setCookie.headerValue, /; Secure(?:;|$)/)
  assert.doesNotMatch(login.setCookie.headerValue, /test-only-password|session-secret/)

  const cookie = cookieRequestHeader(login.setCookie.headerValue)
  assert.deepEqual(auth.session(`theme=night; ${cookie}; harmless=a=b`), login.session)
  const secondInstance = createAdminAuth({
    env: TEST_ENV,
    production: true,
    now: () => clock,
    randomBytes: deterministicBytes
  })
  assert.deepEqual(secondInstance.session(cookie), login.session, 'another instance accepts the shared-secret session')
  clock += ADMIN_SESSION_TTL_MS - 1
  assert.deepEqual(auth.session(cookie), login.session)
  clock += 1
  assert.equal(auth.session(cookie), null)
})

test('local HTTP cookies omit Secure while logout expires the same protected cookie', () => {
  const auth = createAdminAuth({
    env: TEST_ENV,
    production: false,
    now: () => 42,
    randomBytes: deterministicBytes
  })
  const login = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '127.0.0.1' })
  assert.equal(login.ok, true)
  if (!login.ok) return
  assert.doesNotMatch(login.setCookie.headerValue, /; Secure(?:;|$)/)
  const logout = auth.logout()
  assert.equal(logout.status, 204)
  assert.match(logout.setCookie.headerValue, /^clash_admin_session=;/)
  assert.match(logout.setCookie.headerValue, /Max-Age=0/)
  assert.match(logout.setCookie.headerValue, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/)
  assert.match(logout.setCookie.headerValue, /HttpOnly/)
  assert.match(logout.setCookie.headerValue, /SameSite=Strict/)
  assert.doesNotMatch(logout.setCookie.headerValue, /; Secure(?:;|$)/)
})

test('payload and signature forgery are rejected', () => {
  const auth = createAdminAuth({
    env: TEST_ENV,
    now: () => 5_000,
    randomBytes: deterministicBytes
  })
  const login = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '198.51.100.1' })
  assert.equal(login.ok, true)
  if (!login.ok) return
  const cookie = cookieRequestHeader(login.setCookie.headerValue)
  const token = cookie.slice(cookie.indexOf('=') + 1)
  const [payload, signature] = token.split('.')
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
  decoded.exp = Number(decoded.exp) + ADMIN_SESSION_TTL_MS
  const forgedPayload = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
  assert.equal(auth.session(`${ADMIN_SESSION_COOKIE_NAME}=${forgedPayload}.${signature}`), null)
  const flippedSignature = `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`
  assert.equal(auth.session(`${ADMIN_SESSION_COOKIE_NAME}=${payload}.${flippedSignature}`), null)
})

test('mutations require the CSRF token embedded in the signed session', () => {
  const auth = createAdminAuth({
    env: TEST_ENV,
    now: () => 100,
    randomBytes: deterministicBytes
  })
  const login = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '192.0.2.5' })
  assert.equal(login.ok, true)
  if (!login.ok) return
  const cookie = cookieRequestHeader(login.setCookie.headerValue)
  assert.deepEqual(auth.authorizeMutation(undefined, login.session.csrfToken), {
    ok: false,
    status: 401,
    code: 'ADMIN_SESSION_REQUIRED'
  })
  assert.deepEqual(auth.authorizeMutation(cookie, 'wrong-token'), {
    ok: false,
    status: 403,
    code: 'ADMIN_CSRF_INVALID'
  })
  assert.deepEqual(auth.authorizeMutation(cookie, login.session.csrfToken), {
    ok: true,
    session: login.session
  })
})

test('five failures in ten minutes throttle an IP and cleanup restores access', () => {
  let clock = 10_000
  const throttle = new AdminLoginThrottle({ maximumEntries: 4 })
  const auth = createAdminAuth({
    env: TEST_ENV,
    now: () => clock,
    randomBytes: deterministicBytes,
    throttle
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = auth.login({ username: 'admin', password: 'wrong', clientAddress: '10.0.0.8' })
    assert.equal(failed.status, 401)
  }
  const blocked = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '10.0.0.8' })
  assert.deepEqual(blocked, {
    ok: false,
    status: 429,
    code: 'LOGIN_RATE_LIMITED',
    retryAfterSeconds: ADMIN_LOGIN_WINDOW_MS / 1_000
  })
  const otherIp = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '10.0.0.9' })
  assert.equal(otherIp.ok, true)

  clock += ADMIN_LOGIN_WINDOW_MS
  auth.cleanupRateLimits()
  const recovered = auth.login({ username: 'admin', password: 'test-only-password', clientAddress: '10.0.0.8' })
  assert.equal(recovered.ok, true)
  assert.equal(throttle.entryCount, 0)
})

test('rate limiter remains bounded and overflow fails closed', () => {
  const throttle = new AdminLoginThrottle({ maximumEntries: 2, failureLimit: 2, windowMs: 1_000 })
  throttle.recordFailure('10.0.0.1', 0)
  throttle.recordFailure('10.0.0.2', 0)
  throttle.recordFailure('10.0.0.3', 500)
  throttle.recordFailure('10.0.0.4', 500)
  assert.equal(throttle.entryCount, 3, 'two address records plus one fixed overflow record')
  assert.equal(throttle.check('10.0.0.99', 501).allowed, false)
  throttle.cleanup(1_000)
  assert.equal(throttle.entryCount, 1, 'live overflow stays fail-closed after address slots expire')
  assert.equal(throttle.check('10.0.0.99', 1_001).allowed, false)
  throttle.cleanup(1_500)
  assert.equal(throttle.entryCount, 0)
})

test('cookie parser tolerates normal syntax and rejects conflicting duplicates', () => {
  assert.deepEqual(
    [...parseAdminCookies(['a=1', 'quoted="hello%20world"; equals=a=b']).entries()],
    [['a', '1'], ['quoted', 'hello world'], ['equals', 'a=b']]
  )
  assert.equal(parseAdminCookies('clash_admin_session=one; clash_admin_session=two').has(ADMIN_SESSION_COOKIE_NAME), false)
  assert.equal(parseAdminCookies('clash_admin_session=same; clash_admin_session=same').get(ADMIN_SESSION_COOKIE_NAME), 'same')
  assert.equal(parseAdminCookies(`x=${'a'.repeat(17_000)}`).size, 0)
})
