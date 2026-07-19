import { ApiError } from './errors'
import type {
  ApiService,
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
  SaveWorldRequest
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
  body: unknown
}

export interface ApiResult {
  status: number
  body: unknown
}

export function bearerToken(authorization: string | string[] | undefined): string | null {
  const header = Array.isArray(authorization) ? authorization[0] : authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme === 'Bearer' && token ? token : null
}

/**
 * The whole API surface. Every route is same-origin JSON over a bearer session
 * token (no cookies). A device starts as an auto-created guest; registering a
 * username + password makes the account loadable from any device via login.
 */
export function createApiHandler<Principal>(game: ApiService<Principal>) {
  return async function handle(req: ApiRequest): Promise<ApiResult> {
    const { method, path, query, token, clientAddress } = req
    const body = (req.body ?? {}) as Record<string, unknown>

    try {
      if (method === 'GET' && path === '/health') {
        return { status: 200, body: { ok: true, now: Date.now() } }
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

      // Everything below requires a valid device token.
      const player = await game.authenticate(token)

      if (method === 'POST' && path === '/auth/register') {
        return { status: 200, body: { player: await game.register(player, body.username, body.password) } }
      }
      if (method === 'POST' && path === '/player/rename') {
        return { status: 200, body: { player: await game.rename(player, body.name) } }
      }
      if (method === 'POST' && path === '/player/banner') {
        if (!game.setBanner) {
          return { status: 404, body: { error: `Unknown route: ${method} /api${path}` } }
        }
        return { status: 200, body: await game.setBanner(player, body.banner) }
      }
      if (method === 'GET' && path === '/world') {
        return { status: 200, body: { world: await game.getWorld(player) } }
      }
      if (method === 'POST' && path === '/world/save') {
        return { status: 200, body: { world: await game.saveWorld(player, body as SaveWorldRequest) } }
      }
      if (method === 'POST' && path === '/resources/apply') {
        return { status: 200, body: await game.applyResources(player, body as ResourceMutationRequest) }
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
        return { status: 200, body: await game.relocate(player, body.x, body.y) }
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
