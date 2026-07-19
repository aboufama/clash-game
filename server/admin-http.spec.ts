import assert from 'node:assert/strict'
import test from 'node:test'
import { createAdminAuth } from './admin-auth'
import type {
  AdminApiService,
  AdminConfig,
  AdminOperationRequest,
  AdminPlayerActionRequest
} from './admin-contract'
import { createApiHandler, type ApiRequest } from './http'
import type { ApiService } from './runtime/contracts'

const now = 1_800_000_000_000
const auth = () => createAdminAuth({
  env: {
    CLASH_ADMIN_USERNAME: 'admin',
    CLASH_ADMIN_PASSWORD: 'andre',
    CLASH_ADMIN_SESSION_SECRET: 'admin-http-spec-secret-at-least-thirty-two-bytes'
  },
  now: () => now,
  production: false,
  randomBytes: size => Uint8Array.from({ length: size }, (_, index) => index + 1)
})

function makeService() {
  let maintenance = false
  let playerActions = 0
  const config = (): AdminConfig => ({
    maintenance: { enabled: maintenance, message: maintenance ? 'Upgrading the keep' : null },
    accessPolicy: { suspendedSessionsRevoked: true, bannedSessionsRevoked: true },
    safeLimits: { playerList: 100, botList: 100, attackList: 100, auditList: 200, botRadius: 12 },
    updatedAt: now,
    revision: maintenance ? 2 : 1
  })
  const service = {
    authenticate: async () => 'player',
    getWorld: async () => ({ id: 'world' }),
    adminConfig: async () => config(),
    adminOverview: async () => ({
      generatedAt: now,
      players: { total: 1, registered: 1, guests: 0, online: 1 },
      villages: { playerVillages: 1, botVillages: 0 },
      attacks: { active: 0, preparing: 0, engaged: 0, finalizing: 0 },
      economy: { gold: 100, ore: 50, food: 25, averageTrophies: 0 },
      moderation: { suspended: 0, banned: 0 },
      maintenance
    }),
    adminPlayers: async () => [],
    adminPlayer: async () => { throw new Error('not used') },
    adminBots: async () => [],
    adminAttacks: async () => [],
    adminAudit: async () => [],
    adminEconomy: async () => ({ today: 1, days: [] }),
    adminPlayerAction: async (_id: unknown, _action: AdminPlayerActionRequest) => {
      playerActions += 1
      return { ok: true as const, action: 'set_trophies', targetId: 'p1', changed: true, affected: 1, auditId: 'a1' }
    },
    adminOperation: async (operation: AdminOperationRequest) => {
      if (operation.type === 'set_maintenance') maintenance = operation.enabled === true
      return { ok: true as const, action: operation.type, targetId: null, changed: true, affected: 1, auditId: 'a2' }
    }
  }
  return {
    service: service as unknown as ApiService<string> & AdminApiService,
    playerActionCount: () => playerActions
  }
}

function request(overrides: Partial<ApiRequest>): ApiRequest {
  return {
    method: 'GET',
    path: '/admin/overview',
    query: new URLSearchParams(),
    token: null,
    clientAddress: '127.0.0.1',
    body: undefined,
    ...overrides
  }
}

function requestCookie(setCookie: string): string {
  return setCookie.split(';', 1)[0]
}

test('admin HTTP plane requires a signed cookie and CSRF on mutations', async () => {
  const fixture = makeService()
  const handle = createApiHandler(fixture.service, { adminAuth: auth() })

  const anonymous = await handle(request({}))
  assert.equal(anonymous.status, 401)
  assert.deepEqual(anonymous.body, { error: 'Admin session required', code: 'ADMIN_SESSION_REQUIRED' })

  const wrong = await handle(request({
    method: 'POST',
    path: '/admin/auth/login',
    body: { username: 'admin', password: 'wrong' }
  }))
  assert.equal(wrong.status, 401)
  assert.equal((wrong.body as { code: string }).code, 'INVALID_CREDENTIALS')

  const login = await handle(request({
    method: 'POST',
    path: '/admin/auth/login',
    body: { username: 'admin', password: 'andre' }
  }))
  assert.equal(login.status, 200)
  const setCookie = login.headers?.['Set-Cookie']
  assert.equal(typeof setCookie, 'string')
  assert.match(String(setCookie), /HttpOnly/)
  assert.match(String(setCookie), /SameSite=Strict/)
  assert.doesNotMatch(String(setCookie), /; Secure(?:;|$)/)
  const cookie = requestCookie(String(setCookie))
  const csrfToken = (login.body as { csrfToken: string }).csrfToken

  const overview = await handle(request({ cookie }))
  assert.equal(overview.status, 200)
  assert.equal((overview.body as { players: { total: number } }).players.total, 1)

  const missingCsrf = await handle(request({
    method: 'POST',
    path: '/admin/players/p1/actions',
    cookie,
    body: { type: 'set_trophies', trophies: 10, reason: 'spec' }
  }))
  assert.equal(missingCsrf.status, 403)
  assert.equal(fixture.playerActionCount(), 0)

  const mutation = await handle(request({
    method: 'POST',
    path: '/admin/players/p1/actions',
    cookie,
    adminCsrfToken: csrfToken,
    body: { type: 'set_trophies', trophies: 10, reason: 'spec' }
  }))
  assert.equal(mutation.status, 200)
  assert.equal(fixture.playerActionCount(), 1)

  const logout = await handle(request({
    method: 'POST',
    path: '/admin/auth/logout',
    cookie,
    adminCsrfToken: csrfToken,
    body: {}
  }))
  assert.equal(logout.status, 200)
  assert.match(String(logout.headers?.['Set-Cookie']), /Max-Age=0/)
})

test('maintenance blocks the player plane while health and admin stay available', async () => {
  const fixture = makeService()
  const handle = createApiHandler(fixture.service, { adminAuth: auth() })
  const login = await handle(request({
    method: 'POST',
    path: '/admin/auth/login',
    body: { username: 'admin', password: 'andre' }
  }))
  const cookie = requestCookie(String(login.headers?.['Set-Cookie']))
  const csrfToken = (login.body as { csrfToken: string }).csrfToken

  const enabled = await handle(request({
    method: 'POST',
    path: '/admin/operations',
    cookie,
    adminCsrfToken: csrfToken,
    body: { type: 'set_maintenance', enabled: true, message: 'Upgrading the keep', reason: 'deployment' }
  }))
  assert.equal(enabled.status, 200)

  const playerWorld = await handle(request({ path: '/world', token: 'player-token' }))
  assert.equal(playerWorld.status, 503)
  assert.equal((playerWorld.body as { code: string }).code, 'MAINTENANCE')
  assert.equal(playerWorld.headers?.['Retry-After'], '60')

  assert.equal((await handle(request({ path: '/health' }))).status, 200)
  assert.equal((await handle(request({ path: '/admin/config', cookie }))).status, 200)
})

test('missing server credentials fail closed without affecting health', async () => {
  const fixture = makeService()
  const disabledAuth = createAdminAuth({ env: {}, production: false })
  const handle = createApiHandler(fixture.service, { adminAuth: disabledAuth })
  const login = await handle(request({
    method: 'POST',
    path: '/admin/auth/login',
    body: { username: 'admin', password: 'andre' }
  }))
  assert.equal(login.status, 503)
  assert.equal((login.body as { code: string }).code, 'ADMIN_AUTH_UNAVAILABLE')
  assert.equal((await handle(request({ path: '/health' }))).status, 200)
})
