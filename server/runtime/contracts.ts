import type { SerializedWorld } from '../../src/game/data/Models'

export type Awaitable<T> = T | Promise<T>

export interface SaveWorldRequest {
  world?: Partial<SerializedWorld>
  requestId?: unknown
}

export interface ResourceMutationRequest {
  delta?: unknown
  resource?: unknown
  reason?: unknown
  requestId?: unknown
}

export interface ArmyMutationRequest {
  type?: unknown
  count?: unknown
  requestId?: unknown
}

export interface MerchantTradeRequest {
  offerId?: unknown
  requestId?: unknown
}

export interface BotStartRequest {
  x?: unknown
  y?: unknown
  requestId?: unknown
}

export interface BotSettleRequest extends BotStartRequest {
  raidId?: unknown
  destruction?: unknown
  deployed?: unknown
}

export interface AttackStartRequest {
  targetId?: unknown
  requestId?: unknown
}

export interface MatchmakeRequest {
  requestId?: unknown
  /** Previously presented defender; skipped when another candidate exists. */
  excludeTargetId?: unknown
}

export interface AttackCommandRequest {
  attackId?: unknown
  raidId?: unknown
  commands?: unknown
}

export interface AttackFrameRequest {
  attackId?: unknown
  frames?: unknown
}

export interface AttackEndRequest {
  attackId?: unknown
  destruction?: unknown
  goldLooted?: unknown
  status?: unknown
}

/**
 * Transport contract shared by the synchronous JSON compatibility service and
 * asynchronous normalized-persistence runtimes. `Principal` stays opaque to
 * HTTP; PostgreSQL uses a stable player id instead of an in-memory record.
 */
export interface ApiService<Principal> {
  ensureSession(rawToken: unknown, rawAddress?: unknown): Awaitable<unknown>
  login(rawUsername: unknown, rawPassword: unknown, rawAddress?: unknown): Awaitable<unknown>
  logout(rawToken: unknown): Awaitable<void>
  authenticate(rawToken: unknown): Awaitable<Principal>
  register(player: Principal, rawUsername: unknown, rawPassword: unknown): Awaitable<unknown>
  rename(player: Principal, rawName: unknown): Awaitable<unknown>
  /** Optional until the normalized-persistence runtime grows a banner column;
   *  the JSON service implements it fully. Routes 404 when absent. */
  setBanner?(player: Principal, rawBanner: unknown): Awaitable<unknown>

  getWorld(player: Principal): Awaitable<unknown>
  saveWorld(player: Principal, body: SaveWorldRequest): Awaitable<unknown>
  applyResources(player: Principal, body: ResourceMutationRequest): Awaitable<unknown>
  trainTroop(player: Principal, body: ArmyMutationRequest): Awaitable<unknown>
  untrainTroop(player: Principal, body: ArmyMutationRequest): Awaitable<unknown>
  merchantTrade(player: Principal, body: MerchantTradeRequest): Awaitable<unknown>

  atlas(player: Principal): Awaitable<unknown>
  map(
    player: Principal,
    x?: unknown,
    y?: unknown,
    radius?: unknown,
    known?: unknown
  ): Awaitable<unknown>
  relocate(player: Principal, x: unknown, y: unknown): Awaitable<unknown>
  leaderboard(player: Principal): Awaitable<unknown>
  scout(player: Principal, targetId: unknown): Awaitable<unknown>

  botSettle(player: Principal, body: BotSettleRequest): Awaitable<unknown>
  botStart(player: Principal, body: BotStartRequest, rawToken?: unknown): Awaitable<unknown>
  activeOutgoingBattle(player: Principal, rawToken: unknown): Awaitable<unknown>
  abortActiveOutgoingBattle(player: Principal): Awaitable<unknown>
  startAttack(
    player: Principal,
    body: AttackStartRequest,
    matchmade?: boolean,
    rawToken?: unknown
  ): Awaitable<unknown>
  matchmake(player: Principal, body?: MatchmakeRequest, rawToken?: unknown): Awaitable<unknown>
  pushFrames(player: Principal, body: AttackFrameRequest): Awaitable<unknown>
  pushCommands(player: Principal, body: AttackCommandRequest): Awaitable<unknown>
  endAttack(player: Principal, body: AttackEndRequest): Awaitable<unknown>
  incomingAttacks(player: Principal): Awaitable<unknown>
  getReplay(player: Principal, attackId: unknown, afterT?: unknown): Awaitable<unknown>

  listNotifications(player: Principal): Awaitable<unknown>
  getUnread(player: Principal): Awaitable<number>
  markNotificationsRead(player: Principal): Awaitable<void>
  debugClearShields(): Awaitable<unknown>
  /** Optional local-development operation; production runtimes do not expose it. */
  debugReseedWorld?(player: Principal): Awaitable<unknown>
  economyLedger(days?: unknown): Awaitable<unknown>
}

export interface RuntimePrincipal {
  readonly playerId: string
}

/** Attack orchestration is injected so combat and village authority can evolve independently. */
export interface RuntimeAttackService extends Pick<ApiService<RuntimePrincipal>,
  | 'botSettle'
  | 'botStart'
  | 'activeOutgoingBattle'
  | 'abortActiveOutgoingBattle'
  | 'startAttack'
  | 'matchmake'
  | 'pushFrames'
  | 'pushCommands'
  | 'endAttack'
  | 'incomingAttacks'
  | 'getReplay'
> {
  /** Lets an issued attack focus its exact target beyond normal watchtower sight. */
  authorizeMapFocus?(player: RuntimePrincipal, x: number, y: number): Awaitable<boolean>
}
