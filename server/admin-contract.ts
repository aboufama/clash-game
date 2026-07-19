import type { Awaitable } from './runtime/contracts'

/** Shared, secret-free transport contract for the operator portal. */
export type AdminAccessState = 'active' | 'suspended' | 'banned'

export interface AdminOverview {
  generatedAt: number
  players: {
    total: number
    registered: number
    guests: number
    online: number
  }
  villages: {
    playerVillages: number
    botVillages: number
  }
  attacks: {
    active: number
    preparing: number
    engaged: number
    finalizing: number
  }
  economy: {
    gold: number
    ore: number
    food: number
    averageTrophies: number
  }
  moderation: {
    suspended: number
    banned: number
  }
  maintenance: boolean
}

export interface AdminPlayerSummary {
  id: string
  username: string
  registered: boolean
  trophies: number
  shieldUntil: number | null
  createdAt: number
  lastSeenAt: number
  online: boolean
  access: AdminAccessState
  accessUntil: number | null
  world: { worldId: string; x: number; y: number; plotVersion: number } | null
}

export interface AdminPlayerDetail extends AdminPlayerSummary {
  resources: { gold: number; ore: number; food: number }
  revisions: { profile: number; economy: number; layout: number; appearance: number }
  buildingCount: number
  obstacleCount: number
  army: Record<string, number>
  population: number
  activeSessions: number
  activeAttacks: number
  moderationReason: string | null
  moderationUpdatedAt: number | null
}

export interface AdminBotSummary {
  id: string
  username: string
  worldId: string
  x: number
  y: number
  plotVersion: number
  generatorVersion: number
  seed: number
  difficulty: string | null
  trophies: number
  revision: number
  resources: { gold: number; ore: number; food: number }
  buildingCount: number
  createdAt: number
  updatedAt: number
}

export interface AdminAttackSummary {
  id: string
  attackerId: string
  defenderId: string | null
  targetKind: 'player' | 'bot' | 'scenario'
  targetId: string
  worldId: string
  targetX: number
  targetY: number
  state: 'preparing' | 'engaged' | 'active' | 'finalizing' | 'settled' | 'cancelled' | 'expired'
  stateVersion: number
  simulationVersion: number
  createdAt: number
  engagedAt: number | null
  updatedAt: number
  deadlineAt: number
  endedAt: number | null
}

export interface AdminAuditEntry {
  id: string
  actor: string
  action: string
  targetType: 'player' | 'system'
  targetId: string | null
  reason: string
  outcome: 'success'
  requestId: string
  details: Record<string, unknown>
  createdAt: number
  occurredAt: number
}

export interface AdminConfig {
  maintenance: {
    enabled: boolean
    message: string | null
  }
  accessPolicy: {
    suspendedSessionsRevoked: true
    bannedSessionsRevoked: true
  }
  safeLimits: {
    playerList: number
    botList: number
    attackList: number
    auditList: number
    botRadius: number
  }
  updatedAt: number
  revision: number
}

export interface AdminEconomyDay {
  day: number
  faucets: { gold: number; ore: number; food: number }
  sinks: { gold: number; ore: number; food: number }
  refunds: { gold: number; ore: number; food: number }
  loot: { gold: number; ore: number; food: number }
  counts: { saves: number; trades: number; battles: number; botRaids: number }
}

export interface AdminEconomy {
  today: number
  days: AdminEconomyDay[]
}

export type AdminPlayerActionRequest =
  | { type: 'adjust_resources'; gold?: unknown; ore?: unknown; food?: unknown; reason?: unknown }
  | { type: 'set_trophies'; trophies?: unknown; reason?: unknown }
  | { type: 'set_shield'; until?: unknown; reason?: unknown }
  | { type: 'rename'; username?: unknown; reason?: unknown }
  | { type: 'revoke_sessions'; reason?: unknown }
  | {
      type: 'set_access'
      state?: unknown
      until?: unknown
      reason?: unknown
    }
  | {
      type: 'send_notice'
      title?: unknown
      message?: unknown
      severity?: unknown
      reason?: unknown
    }

export type AdminOperationRequest =
  | { type: 'clear_shields'; reason?: unknown }
  | { type: 'set_maintenance'; enabled?: unknown; message?: unknown; reason?: unknown }

export interface AdminMutationResult {
  ok: true
  action: string
  targetId: string | null
  changed: boolean
  affected: number
  auditId: string
}

export interface AdminApiService {
  adminOverview(): Awaitable<AdminOverview>
  adminPlayers(search?: unknown, limit?: unknown): Awaitable<AdminPlayerSummary[]>
  adminPlayer(id: unknown): Awaitable<AdminPlayerDetail>
  adminBots(
    center?: { worldId?: unknown; x?: unknown; y?: unknown },
    radius?: unknown,
    limit?: unknown
  ): Awaitable<AdminBotSummary[]>
  adminAttacks(state?: unknown, limit?: unknown): Awaitable<AdminAttackSummary[]>
  adminAudit(limit?: unknown): Awaitable<AdminAuditEntry[]>
  adminConfig(): Awaitable<AdminConfig>
  adminEconomy(days?: unknown): Awaitable<AdminEconomy>
  adminPlayerAction(id: unknown, action: AdminPlayerActionRequest): Awaitable<AdminMutationResult>
  adminOperation(action: AdminOperationRequest): Awaitable<AdminMutationResult>
}
