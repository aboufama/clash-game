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

export interface ArmyBatchRequest {
  operations?: unknown
  requestId?: unknown
}

export interface MerchantTradeRequest {
  offerId?: unknown
  requestId?: unknown
}

export interface BotStartRequest {
  x?: unknown
  y?: unknown
  /** Previously offered cloud-camp coordinates (`"x,y"`), max 64. */
  excludeCampKeys?: unknown
  requestId?: unknown
}

export const BOT_CAMP_EXCLUSION_LIMIT = 64

export interface BotSettleRequest extends BotStartRequest {
  raidId?: unknown
  destruction?: unknown
  deployed?: unknown
}

export interface AttackStartRequest {
  targetId?: unknown
  requestId?: unknown
}

/** Hard cap on the NEXT-cycling exclusion list (matches the client's bound). */
export const MATCHMAKE_EXCLUSION_LIMIT = 64

export interface MatchmakeRequest {
  requestId?: unknown
  /**
   * SOFT exclusion — the previously presented defender. Skipped when another
   * candidate exists, but reused rather than failing a one-opponent world.
   */
  excludeTargetId?: unknown
  /**
   * STRICT exclusions — every defender already offered in this NEXT-cycling
   * session (bounded by MATCHMAKE_EXCLUSION_LIMIT). Never returned again:
   * when they cover the whole eligible pool the request fails 404 with
   * code MATCH_POOL_EXHAUSTED so the client can fall back to bot camps.
   */
  excludeTargetIds?: unknown
}

export interface HomeSyncResponse {
  serverNow: number
  world: { revision: number; lastSaveTime: number }
  shieldUntil: number
  features: {
    infiniteResources: boolean
    testMode: boolean
    testModeActivationId: string | null
    testModeAnnouncementPending: boolean
    introBattleRequired: boolean
    watchtowerPlacementRequired: boolean
  }
  upgradePolicy: {
    fixedDurationMs?: number
    timeScale?: number
  }
  incomingAttack: null | {
    attackId: string
    attackerId: string
    attackerName: string
    startedAt: number
    updatedAt: number
  }
}

export interface TestModeAnnouncementClaimRequest {
  activationId?: unknown
}

export interface TestModeAnnouncementClaimResponse {
  activationId: string
  show: boolean
}

export interface IntroBattleCompletionResponse {
  ok: true
  introBattleRequired: false
}

export interface WatchtowerPlacementResponse {
  world: SerializedWorld
  watchtowerPlacementRequired: false
}

export interface AttackCommandRequest {
  attackId?: unknown
  raidId?: unknown
  commands?: unknown
}

export interface AttackFrameRequest {
  attackId?: unknown
  frames?: unknown
  replayV2?: unknown
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
  /**
   * With a valid bearer token: upgrade that guest account in place. With no
   * token: create the account, allocate its plot and issue a session (the
   * production registration wall's entry point) — hence raw token, not an
   * authenticated principal.
   */
  register(rawToken: unknown, rawUsername: unknown, rawPassword: unknown, rawAddress?: unknown): Awaitable<unknown>
  /** Reject gameplay mutations until this authenticated player chose complete heraldry. */
  assertGameplayReady(player: Principal): Awaitable<void>
  rename(player: Principal, rawName: unknown): Awaitable<unknown>
  /** Persist one complete, server-validated heraldry choice. */
  setBanner(player: Principal, rawBanner: unknown): Awaitable<unknown>

  getWorld(player: Principal): Awaitable<unknown>
  homeSync(player: Principal): Awaitable<HomeSyncResponse>
  claimTestModeAnnouncement(
    player: Principal,
    body: TestModeAnnouncementClaimRequest
  ): Awaitable<TestModeAnnouncementClaimResponse>
  completeIntroBattle(player: Principal): Awaitable<IntroBattleCompletionResponse>
  placeTutorialWatchtower(player: Principal, body: SaveWorldRequest): Awaitable<WatchtowerPlacementResponse>
  saveWorld(player: Principal, body: SaveWorldRequest): Awaitable<unknown>
  applyResources(player: Principal, body: ResourceMutationRequest): Awaitable<unknown>
  trainTroop(player: Principal, body: ArmyMutationRequest): Awaitable<unknown>
  untrainTroop(player: Principal, body: ArmyMutationRequest): Awaitable<unknown>
  armyBatch(player: Principal, body: ArmyBatchRequest): Awaitable<unknown>
  merchantTrade(player: Principal, body: MerchantTradeRequest): Awaitable<unknown>

  atlas(player: Principal): Awaitable<unknown>
  /** Compact live-combat feed for in-world postcards inside current Watchtower sight. */
  visibleAttackActivity(player: Principal): Awaitable<unknown>
  map(
    player: Principal,
    x?: unknown,
    y?: unknown,
    radius?: unknown,
    known?: unknown
  ): Awaitable<unknown>
  relocate(player: Principal, x: unknown, y: unknown, requestId?: unknown): Awaitable<unknown>
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
  getReplay(player: Principal, attackId: unknown, afterT?: unknown, afterV2Sequence?: unknown): Awaitable<unknown>

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
