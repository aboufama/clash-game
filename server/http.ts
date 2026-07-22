import { ApiError } from './errors'
import { createAdminAuth, type AdminAuth } from './admin-auth'
import type {
  AdminApiService,
  AdminOperationRequest,
  AdminPlayerActionRequest
} from './admin-contract'
import type {
  ApiService,
  ArmyBatchRequest,
  ArmyMutationRequest,
  AttackCommandRequest,
  AttackEndRequest,
  AttackFrameRequest,
  AttackStartRequest,
  BotSettleRequest,
  BotStartRequest,
  MatchmakeRequest,
  MerchantTradeRequest,
  ResourceMutationRequest,
  SaveWorldRequest,
  TestModeAnnouncementClaimRequest
} from './runtime/contracts'

export interface ApiRequest {
  method: string
  /** Path with the /api prefix stripped, e.g. "/auth/session". Query string removed. */
  path: string
  query: URLSearchParams
  /** Bearer token from the Authorization header, if any. */
  token: string | null
  /** Network identity used only for anonymous/auth abuse throttles. */
  clientAddress?: string
  /** Raw Cookie request header. Player auth never reads this; admin auth does. */
  cookie?: string | readonly string[]
  /** Per-session admin CSRF proof supplied on state-changing operator routes. */
  adminCsrfToken?: unknown
  body: unknown
}

export interface ApiResult {
  status: number
  body: unknown
  headers?: Record<string, string | readonly string[]>
}

/**
 * Authenticated POST routes which change durable game state. Auth/session
 * routes are dispatched before authentication, and /player/banner is the one
 * onboarding mutation deliberately exempt from this set. Keeping the gate at
 * dispatch means every current and future runtime receives the same policy.
 */
const GAMEPLAY_MUTATION_PATHS = new Set([
  '/player/rename',
  '/world/save',
  '/resources/apply',
  '/army/batch',
  '/army/train',
  '/army/untrain',
  '/merchant/trade',
  '/attacks/bot-settle',
  '/attacks/bot-start',
  '/attacks/active/abort',
  '/map/relocate',
  '/debug/clear-shields',
  '/debug/reseed-world',
  '/attacks/start',
  '/attacks/matchmake',
  '/attacks/frames',
  '/attacks/commands',
  '/attacks/end',
  '/notifications/read'
])

export function bearerToken(authorization: string | string[] | undefined): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme === 'Bearer' && token ? token : null
}

/**
 * The whole API surface. Every route is same-origin JSON over a bearer session
 * token (no cookies). In production a fresh device must register a username +
 * password (or log in) before it gets a village — /auth/session answers
 * `{ registrationRequired: true }` until then. With CLASH_ALLOW_GUESTS=1
 * (dev/harnesses) a tokenless device auto-creates a playable guest instead;
 * registering later upgrades that guest in place. Valid tokens always resume
 * their account either way.
 */
export function createApiHandler<Principal>(
  game: ApiService<Principal>,
  options: { adminAuth?: AdminAuth } = {}
) {
  const adminAuth = options.adminAuth ?? createAdminAuth()
  let maintenanceCache: { checkedAt: number; enabled: boolean; message: string | null } | null = null
  // Player mutations still take the database maintenance fence inside their
  // authority transaction. This cache only avoids a separate config
  // transaction on every read/auth request and may safely be a little slower.
  const maintenanceCacheTtlMs = 5_000

  const requireAdminService = (): AdminApiService => {
    const candidate = game as Partial<AdminApiService>
    const required: Array<keyof AdminApiService> = [
      'adminOverview', 'adminPlayers', 'adminPlayer', 'adminBots', 'adminAttacks',
      'adminAudit', 'adminConfig', 'adminEconomy', 'adminPlayerAction', 'adminOperation'
    ]
    if (required.some(method => typeof candidate[method] !== 'function')) {
      throw new ApiError(503, 'The admin data service is unavailable', 'ADMIN_SERVICE_UNAVAILABLE')
    }
    return candidate as AdminApiService
  }

  const adminSessionBody = (session: { username: string; expiresAt: number; csrfToken: string }) => ({
    authenticated: true,
    username: session.username,
    expiresAt: session.expiresAt,
    csrfToken: session.csrfToken
  })

  const maintenanceStatus = async () => {
    const now = Date.now()
    if (maintenanceCache && now - maintenanceCache.checkedAt < maintenanceCacheTtlMs) return maintenanceCache
    const adminCandidate = game as ApiService<Principal> & Partial<AdminApiService>
    if (typeof adminCandidate.adminConfig !== 'function') {
      maintenanceCache = { checkedAt: now, enabled: false, message: null }
      return maintenanceCache
    }
    const config = await adminCandidate.adminConfig()
    maintenanceCache = {
      checkedAt: now,
      enabled: config.maintenance.enabled,
      message: config.maintenance.message
    }
    return maintenanceCache
  }

  return async function handle(req: ApiRequest): Promise<ApiResult> {
    const { method, path, query, token, clientAddress, cookie, adminCsrfToken } = req
    const body = (req.body ?? {}) as Record<string, unknown>

    try {
      if (method === 'GET' && path === '/health') {
        return { status: 200, body: { ok: true, now: Date.now() } }
      }

      // Operator auth and data are deliberately dispatched before player
      // bearer auth and maintenance checks. A broken/blocked player session
      // must never prevent an operator from repairing the game.
      if (method === 'POST' && path === '/admin/auth/login') {
        const result = adminAuth.login({
          username: body.username,
          password: body.password,
          clientAddress
        })
        if (result.ok === false) {
          const retryHeaders = result.status === 429
            ? { 'Retry-After': String(result.retryAfterSeconds) }
            : undefined
          return {
            status: result.status,
            body: {
              error: result.status === 503
                ? 'Admin authentication is not configured'
                : result.status === 429
                  ? 'Too many admin login attempts; retry later'
                  : 'Invalid admin credentials',
              code: result.code,
              ...(result.status === 401 ? { remainingAttempts: result.remainingAttempts } : {})
            },
            ...(retryHeaders ? { headers: retryHeaders } : {})
          }
        }
        return {
          status: 200,
          body: adminSessionBody(result.session),
          headers: { [result.setCookie.headerName]: result.setCookie.headerValue }
        }
      }
      if (method === 'GET' && path === '/admin/auth/session') {
        const session = adminAuth.session(cookie)
        if (!session) {
          return { status: 401, body: { error: 'Admin session required', code: 'ADMIN_SESSION_REQUIRED' } }
        }
        return { status: 200, body: adminSessionBody(session) }
      }
      if (method === 'POST' && path === '/admin/auth/logout') {
        const authorization = adminAuth.authorizeMutation(cookie, adminCsrfToken)
        const logout = adminAuth.logout()
        if (authorization.ok === false) {
          return {
            status: authorization.status,
            body: {
              error: authorization.status === 403 ? 'Invalid admin CSRF token' : 'Admin session required',
              code: authorization.code
            },
            headers: { [logout.setCookie.headerName]: logout.setCookie.headerValue }
          }
        }
        return {
          status: 200,
          body: { ok: true },
          headers: { [logout.setCookie.headerName]: logout.setCookie.headerValue }
        }
      }

      if (path.startsWith('/admin/')) {
        const session = adminAuth.session(cookie)
        if (!session) {
          return { status: 401, body: { error: 'Admin session required', code: 'ADMIN_SESSION_REQUIRED' } }
        }
        if (method !== 'GET' && method !== 'HEAD') {
          const authorization = adminAuth.authorizeMutation(cookie, adminCsrfToken)
          if (authorization.ok === false) {
            return {
              status: authorization.status,
              body: {
                error: authorization.status === 403 ? 'Invalid admin CSRF token' : 'Admin session required',
                code: authorization.code
              }
            }
          }
        }
        const admin = requireAdminService()
        if (method === 'GET' && path === '/admin/overview') {
          return { status: 200, body: await admin.adminOverview() }
        }
        if (method === 'GET' && path === '/admin/players') {
          return { status: 200, body: { players: await admin.adminPlayers(query.get('q') ?? undefined, query.get('limit') ?? undefined) } }
        }
        const adminPlayerMatch = path.match(/^\/admin\/players\/([^/]+)$/)
        if (method === 'GET' && adminPlayerMatch) {
          return { status: 200, body: await admin.adminPlayer(adminPlayerMatch[1]) }
        }
        const adminPlayerActionMatch = path.match(/^\/admin\/players\/([^/]+)\/actions$/)
        if (method === 'POST' && adminPlayerActionMatch) {
          return {
            status: 200,
            body: await admin.adminPlayerAction(
              adminPlayerActionMatch[1],
              body as unknown as AdminPlayerActionRequest
            )
          }
        }
        if (method === 'GET' && path === '/admin/bots') {
          const worldId = query.get('worldId') ?? undefined
          const x = query.get('x') ?? undefined
          const y = query.get('y') ?? undefined
          return {
            status: 200,
            body: {
              bots: await admin.adminBots(
                worldId !== undefined || x !== undefined || y !== undefined ? { worldId, x, y } : undefined,
                query.get('radius') ?? undefined,
                query.get('limit') ?? undefined
              )
            }
          }
        }
        if (method === 'GET' && path === '/admin/attacks') {
          return { status: 200, body: { attacks: await admin.adminAttacks(query.get('state') ?? undefined, query.get('limit') ?? undefined) } }
        }
        if (method === 'GET' && path === '/admin/economy') {
          return { status: 200, body: await admin.adminEconomy(query.get('days') ?? undefined) }
        }
        if (method === 'GET' && path === '/admin/audit') {
          return { status: 200, body: { entries: await admin.adminAudit(query.get('limit') ?? undefined) } }
        }
        if (method === 'GET' && path === '/admin/config') {
          return { status: 200, body: await admin.adminConfig() }
        }
        if (method === 'POST' && path === '/admin/operations') {
          const result = await admin.adminOperation(body as unknown as AdminOperationRequest)
          maintenanceCache = null
          return { status: 200, body: result }
        }
        return { status: 404, body: { error: `Unknown route: ${method} /api${path}` } }
      }

      // Maintenance keeps health, logout and the complete admin plane alive,
      // while preventing new player sessions and stale clients from mutating
      // or reading a half-maintained world.
      if (!(method === 'POST' && path === '/auth/logout')) {
        const maintenance = await maintenanceStatus()
        if (maintenance.enabled) {
          return {
            status: 503,
            body: {
              error: maintenance.message || 'The game is temporarily under maintenance',
              code: 'MAINTENANCE'
            },
            headers: { 'Retry-After': '60' }
          }
        }
      }

      if (method === 'POST' && path === '/auth/session') {
        return { status: 200, body: await game.ensureSession(body.token ?? token, clientAddress) }
      }
      if (method === 'POST' && path === '/auth/login') {
        return { status: 200, body: await game.login(body.username, body.password, clientAddress) }
      }
      if (method === 'POST' && path === '/auth/logout') {
        // Deliberately lenient: revoking an already-dead token is still a successful logout.
        await game.logout(body.token ?? token)
        return { status: 200, body: { ok: true } }
      }
      if (method === 'POST' && path === '/auth/register') {
        // Two modes, decided by the service: a valid bearer token upgrades
        // that guest in place ({ player }); no token creates the account,
        // allocates its plot and answers a full session envelope.
        return { status: 200, body: await game.register(token, body.username, body.password, clientAddress) }
      }

      // Everything below requires a valid device token.
      const player = await game.authenticate(token)

      if (method === 'POST' && path === '/test-mode/announcement/claim') {
        return {
          status: 200,
          body: await game.claimTestModeAnnouncement(
            player,
            body as TestModeAnnouncementClaimRequest
          )
        }
      }
      if (method === 'POST' && path === '/intro-battle/complete') {
        return { status: 200, body: await game.completeIntroBattle(player) }
      }
      if (method === 'POST' && path === '/watchtower-tutorial/place') {
        return {
          status: 200,
          body: await game.placeTutorialWatchtower(player, body as SaveWorldRequest)
        }
      }

      if (method === 'POST' && path === '/player/banner') {
        if (!game.setBanner) {
          return { status: 404, body: { error: `Unknown route: ${method} /api${path}` } }
        }
        return { status: 200, body: await game.setBanner(player, body.banner) }
      }
      if (method === 'POST' && GAMEPLAY_MUTATION_PATHS.has(path)) {
        await game.assertGameplayReady(player)
      }
      if (method === 'POST' && path === '/player/rename') {
        return { status: 200, body: { player: await game.rename(player, body.name) } }
      }
      if (method === 'GET' && path === '/world') {
        return { status: 200, body: { world: await game.getWorld(player) } }
      }
      if (method === 'GET' && path === '/home/sync') {
        return { status: 200, body: await game.homeSync(player) }
      }
      if (method === 'POST' && path === '/world/save') {
        return { status: 200, body: { world: await game.saveWorld(player, body as SaveWorldRequest) } }
      }
      if (method === 'POST' && path === '/resources/apply') {
        return { status: 200, body: await game.applyResources(player, body as ResourceMutationRequest) }
      }
      if (method === 'POST' && path === '/army/batch') {
        return { status: 200, body: await game.armyBatch(player, body as ArmyBatchRequest) }
      }
      if (method === 'POST' && path === '/army/train') {
        return { status: 200, body: await game.trainTroop(player, body as ArmyMutationRequest) }
      }
      if (method === 'POST' && path === '/army/untrain') {
        return { status: 200, body: await game.untrainTroop(player, body as ArmyMutationRequest) }
      }
      if (method === 'POST' && path === '/merchant/trade') {
        return { status: 200, body: await game.merchantTrade(player, body as MerchantTradeRequest) }
      }
      if (method === 'POST' && path === '/attacks/bot-settle') {
        return { status: 200, body: await game.botSettle(player, body as BotSettleRequest) }
      }
      if (method === 'POST' && path === '/attacks/bot-start') {
        return { status: 200, body: await game.botStart(player, body as BotStartRequest, token) }
      }
      if (method === 'GET' && path === '/attacks/active') {
        return { status: 200, body: await game.activeOutgoingBattle(player, token) }
      }
      if (method === 'POST' && path === '/attacks/active/abort') {
        return { status: 200, body: await game.abortActiveOutgoingBattle(player) }
      }
      if (method === 'GET' && path === '/map/atlas') {
        return { status: 200, body: await game.atlas(player) }
      }
      if (method === 'GET' && path === '/map') {
        return { status: 200, body: await game.map(player, query.get('x') ?? undefined, query.get('y') ?? undefined, query.get('r') ?? undefined, query.get('known') ?? undefined) }
      }
      if (method === 'POST' && path === '/map/relocate') {
        return { status: 200, body: await game.relocate(player, body.x, body.y, body.requestId) }
      }
      if (method === 'GET' && path === '/leaderboard') {
        return { status: 200, body: { players: await game.leaderboard(player) } }
      }
      if (method === 'POST' && path === '/debug/clear-shields') {
        return { status: 200, body: await game.debugClearShields() }
      }
      if (method === 'POST' && path === '/debug/reseed-world') {
        if (process.env.CLASH_ALLOW_WORLD_RESEED !== '1' || !game.debugReseedWorld) {
          return { status: 404, body: { error: `Unknown route: ${method} /api${path}` } }
        }
        return { status: 200, body: await game.debugReseedWorld(player) }
      }
      if (method === 'GET' && path === '/economy/ledger') {
        return { status: 200, body: await game.economyLedger(query.get('days') ?? undefined) }
      }

      const scoutMatch = path.match(/^\/players\/([^/]+)\/world$/)
      if (method === 'GET' && scoutMatch) {
        return { status: 200, body: { world: await game.scout(player, scoutMatch[1]) } }
      }

      if (method === 'POST' && path === '/attacks/start') {
        return { status: 200, body: await game.startAttack(player, body as AttackStartRequest, false, token) }
      }
      if (method === 'POST' && path === '/attacks/matchmake') {
        return { status: 200, body: await game.matchmake(player, body as MatchmakeRequest, token) }
      }
      if (method === 'POST' && path === '/attacks/frames') {
        return { status: 200, body: await game.pushFrames(player, body as AttackFrameRequest) }
      }
      if (method === 'POST' && path === '/attacks/commands') {
        return { status: 200, body: await game.pushCommands(player, body as AttackCommandRequest) }
      }
      if (method === 'POST' && path === '/attacks/end') {
        return { status: 200, body: await game.endAttack(player, body as AttackEndRequest) }
      }
      if (method === 'GET' && path === '/attacks/incoming') {
        return { status: 200, body: { sessions: await game.incomingAttacks(player) } }
      }

      const replayMatch = path.match(/^\/replays\/([^/]+)$/)
      if (method === 'GET' && replayMatch) {
        return { status: 200, body: { replay: await game.getReplay(player, replayMatch[1], query.get('afterT') ?? undefined) } }
      }

      if (method === 'GET' && path === '/notifications') {
        const [items, unread] = await Promise.all([game.listNotifications(player), game.getUnread(player)])
        return { status: 200, body: { items, unread } }
      }
      if (method === 'POST' && path === '/notifications/read') {
        await game.markNotificationsRead(player)
        return { status: 200, body: { ok: true } }
      }

      return { status: 404, body: { error: `Unknown route: ${method} /api${path}` } }
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, body: { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.details ?? {}) } }
      }
      console.error(`[api] ${method} ${path} failed:`, error)
      return { status: 500, body: { error: 'Internal server error' } }
    }
  }
}
