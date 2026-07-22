import type { SerializedBuilding, SerializedObstacle, SerializedWorld, VillageBanner, VillageLifeManifest } from '../src/game/data/Models'
import type { AttackAggregate } from './attack-domain'
export type { VillageBanner, VillageLifeManifest } from '../src/game/data/Models'
export type { RegistrationRequiredResponse } from './domain/auth'

/** A village postcard that is safe to expose to nearby players. */
export interface PublicWorldSnapshot {
  id: string
  ownerId: string
  username: string
  buildings: SerializedBuilding[]
  obstacles: SerializedObstacle[]
  wallLevel: number
  lastSaveTime: number
  revision: number
  life: VillageLifeManifest
  /** Owner-chosen heraldry; omitted while banner onboarding is incomplete. */
  banner?: VillageBanner
}

/** Public profile of a player, as exposed to clients. */
export interface PlayerProfile {
  id: string
  username: string
  trophies: number
  /** Permanent home coordinates on the global village grid. */
  plotX: number
  plotY: number
  /** Post-raid protection: attacks on this player are blocked until then. */
  shieldUntil: number
  createdAt: number
  lastSeen: number
  /** True once the account has a username + password and can be loaded from any device. */
  registered: boolean
}

export interface LeaderboardEntry {
  id: string
  username: string
  trophies: number
  buildingCount: number
  lastSeen: number
  online: boolean
  plotX: number
  plotY: number
  inScoutRange: boolean
}

export interface AttackNotificationItem {
  id: string
  attackId: string
  attackerId: string
  attackerName: string
  goldLost: number
  oreLost?: number
  foodLost?: number
  destruction: number
  trophyDelta: number
  time: number
  read: boolean
  replayAvailable: boolean
}

export interface ReplayBuildingState {
  id: string
  health: number
  isDestroyed: boolean
  /** Committed aim of rotating defenses, in radians. */
  ballistaAngle?: number
}

export interface ReplayTroopState {
  id: string
  type: string
  level: number
  owner: 'PLAYER' | 'ENEMY'
  gridX: number
  gridY: number
  visualOffsetY?: number
  health: number
  maxHealth: number
  facingAngle?: number
  hasTakenDamage?: boolean
  slamOffset?: number
  mortarRecoil?: number
  parked01?: number
  phalanxSpearOffset?: number
  tankSpin01?: number
}

export interface ReplayFrame {
  t: number
  destruction: number
  goldLooted: number
  oreLooted?: number
  foodLooted?: number
  buildings: ReplayBuildingState[]
  troops: ReplayTroopState[]
}

/**
 * Replay-v2 separates discrete combat presentation events from periodic state
 * correction keyframes. `sequence` is one contiguous stream shared by both
 * kinds, so a consumer can apply them in deterministic order without deriving
 * damage timing from sparse snapshots.
 */
export type ReplayV2CombatEventType =
  | 'troop.spawn'
  | 'combat.attack'
  | 'defense.charge'
  | 'defense.fire'
  | 'projectile.launch'
  | 'projectile.impact'
  | 'combat.damage'
  | 'combat.heal'
  | 'entity.death'
  | 'building.destroy'
  | 'ability'
  | 'status'
  | 'fx'
  | 'sound'

export interface ReplayV2CombatEvent {
  version: 1
  id: string
  seed: number
  type: ReplayV2CombatEventType
  /**
   * Type-specific JSON payload authored by the client presentation seam. The
   * server deliberately preserves it opaquely so new effects do not require a
   * persistence migration; version/type remain the validation boundary.
   */
  payload: Record<string, unknown>
}

export interface ReplayV2EventChunk {
  kind: 'event'
  sequence: number
  t: number
  event: ReplayV2CombatEvent
}

export interface ReplayV2KeyframeChunk {
  kind: 'keyframe'
  sequence: number
  t: number
  /** Terminal correction keyframes bypass the rolling presentation budget. */
  terminal?: boolean
  frame: ReplayFrame
}

export type ReplayV2Chunk = ReplayV2EventChunk | ReplayV2KeyframeChunk

export interface ReplayV2Batch {
  chunks: ReplayV2Chunk[]
}

export interface ReplayPushReceipt {
  /** Legacy v1 storage high-water; retained for old clients. */
  frameCount: number
  acceptedFrames: number
  replacedFrames: number
  duplicateFrames: number
  droppedFrames: number
  acceptedV2: number
  duplicateV2: number
  droppedV2: number
  lastV2Sequence: number
  /** True once the v2 budget is exhausted; only a final correction may follow. */
  terminalOnlyV2: boolean
}

export type AttackStatus = 'live' | 'finished' | 'aborted'

/** Full attack/replay record. Fetched in a single request, so replays start instantly. */
export interface AttackRecord {
  attackId: string
  attackerId: string
  attackerName: string
  victimId: string
  victimName: string
  status: AttackStatus
  startedAt: number
  updatedAt: number
  endedAt?: number
  /** Snapshot of the defender's base at the moment the attack started. */
  /** Present on full fetches; omitted from incremental (afterT) spectate polls. */
  enemyWorld?: SerializedWorld
  /** Max gold this attack can award, fixed when the attack starts. */
  lootCap: number
  /** Max ore/food (after storehouse protection), fixed when the attack starts. */
  lootCapOre?: number
  lootCapFood?: number
  /** Immutable army snapshot used to validate and reserve deployments. */
  reservedArmy?: Record<string, number>
  /** Valid first-generation troop ids observed in the replay stream. */
  validatedDeployments?: Record<string, string>
  /** Server receipt time for each validated root deployment. */
  deploymentTimes?: Record<string, number>
  /** Server-authoritative lab level captured at attack start. Internal only. */
  troopLevel?: number
  /** Monotonic union of destroyed defender ids observed in accepted frames. Internal only. */
  destroyedBuildingIds?: string[]
  /** Defender coordinates captured with the snapshot. Internal only. */
  victimPlotX?: number
  victimPlotY?: number
  victimPlotVersion?: number
  /** Internal authorization for road-battle neighborhood pre-rendering. */
  mapFocusAuthorized?: boolean
  /** Versioned server-authoritative command/state-machine aggregate. Internal only. */
  authority?: AttackAggregate
  /** Internal idempotency key for attack-start response retries. */
  startRequestId?: string
  /** Hash of the device token that opened the attack. Internal only. */
  ownerTokenHash?: string
  /** Write-ahead start side effects, internal only. */
  startEffects?: { dropShield: boolean; revengeVictimId?: string }
  startEffectsApplied?: boolean
  /** Exact serialized bytes, maintained by the server for memory bounds. */
  byteSize?: number
  frames: ReplayFrame[]
  /** Ordered replay-v2 event/keyframe stream, when published by a v2 client. */
  v2Chunks?: ReplayV2Chunk[]
  lastV2Sequence?: number
  /** Internal legacy-runtime state: preserve only a final correction after a budget drop. */
  replayV2TerminalOnly?: boolean
  /** Highest replay transport version included in this response. */
  replayVersion?: 1 | 2
  /** The event stream was truncated and is completed by its terminal keyframe. */
  terminalOnlyV2?: boolean
  finalResult?: {
    destruction: number
    goldLooted: number
    oreLooted?: number
    foodLooted?: number
    trophyDelta: number
  }
}

export interface IncomingAttack {
  attackId: string
  attackerId: string
  attackerName: string
  victimId: string
  startedAt: number
  updatedAt: number
}

/** Compact Watchtower-authorized feed used by in-world postcard battles. */
export interface VisibleAttackActivity {
  attackId: string
  targetKind: 'player' | 'bot'
  targetId: string
  /** Present for player targets; bot targets are reserved for future capture support. */
  defenderId?: string
  x: number
  y: number
  /** Server epoch corresponding to replay t=0. */
  combatStartedAt: number
  updatedAt: number
}

export interface VisibleAttackActivityResponse {
  activities: VisibleAttackActivity[]
  serverNow: number
}

// ---- Request/response bodies ----

export interface SessionResponse {
  token: string
  player: PlayerProfile
  world: SerializedWorld
  created: boolean
  unread: number
  features: {
    infiniteResources: boolean
    /** Server-authoritative operator entitlement for instant upgrades and unlocked troops. */
    testMode: boolean
    /** Opaque identity of the account's current effective Test Mode activation. */
    testModeActivationId: string | null
    /** True until one session atomically claims this activation's announcement. */
    testModeAnnouncementPending: boolean
    /** Mandatory onboarding battle remains until the account records completion. */
    introBattleRequired: boolean
    /** First home-base lesson remains until a Watchtower save is authoritative. */
    watchtowerPlacementRequired: boolean
  }
}

export interface EndAttackResponse {
  lootApplied: number
  oreApplied?: number
  foodApplied?: number
  attackerBalance: number
  attackerOre?: number
  attackerFood?: number
  trophyDelta: number
  attackerTrophies: number
  /** Authoritative player revision after settlement. */
  revision?: number
  /** The attacker's army after battle consumption (absent on legacy paths). */
  army?: Record<string, number>
}

/** Every attack is anchored to one real world plot, regardless of selection source. */
export interface StartedAttackResponse {
  attackId: string
  world: SerializedWorld
  /** Immutable attacker army owned by this attack reservation. */
  reservedArmy: Record<string, number>
  lootCap: number
  lootCapOre: number
  lootCapFood: number
  target: {
    worldId: string
    x: number
    y: number
    plotVersion: number
  }
  /** Optional target-centered presentation window. Older clients ignore it;
   * newer clients avoid a second map request during the cloud transition. */
  focusWindow?: unknown
}
