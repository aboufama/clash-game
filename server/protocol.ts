import type { SerializedBuilding, SerializedObstacle, SerializedWorld, VillageLifeManifest } from '../src/game/data/Models'
import type { AttackAggregate } from './attack-domain'
export type { VillageLifeManifest } from '../src/game/data/Models'

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
}

export interface ReplayTroopState {
  id: string
  type: string
  level: number
  owner: 'PLAYER' | 'ENEMY'
  gridX: number
  gridY: number
  health: number
  maxHealth: number
  recursionGen?: number
  facingAngle?: number
  hasTakenDamage?: boolean
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

// ---- Request/response bodies ----

export interface SessionResponse {
  token: string
  player: PlayerProfile
  world: SerializedWorld
  created: boolean
  unread: number
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
  lootCap: number
  lootCapOre: number
  lootCapFood: number
  target: {
    worldId: string
    x: number
    y: number
    plotVersion: number
  }
}
