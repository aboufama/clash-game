import type {
  AdminAttackQuery,
  AdminPlayerQuery,
  AttackCandidateQuery,
  AttackCommandQuery,
  NotificationQuery,
  ParticipantReplayQuery,
  WorldAtlasQuery,
  WorldPlayerDirectoryQuery
} from './model'
import type { BotVillageRecord } from './model'

/** Hard request-path caps. Repository callers must always supply a limit. */
export const QUERY_LIMITS = Object.freeze({
  leaderboard: 200,
  attackCandidates: 100,
  worldAtlas: 1_024,
  worldAtlasSpan: 256,
  worldOccupancyBatch: 128,
  botVillageProvisionBatch: 128,
  activeAttacks: 100,
  activeAttackBatch: 1_024,
  attackPlayerIds: 1_024,
  attackCommands: 512,
  replayChunks: 128,
  notifications: 100,
  notificationRetention: 50,
  idempotencyPrune: 500,
  outboxPrune: 500,
  operationMarkerPrune: 500,
  trophyRadius: 10_000,
  adminPlayers: 100,
  adminBots: 200,
  adminAttacks: 200,
  adminAudit: 250,
  adminBotRadius: 127
})

export function boundBotVillageProvisionBatch(
  records: readonly BotVillageRecord[]
): BotVillageRecord[] {
  if (!Array.isArray(records)) throw new RangeError('bot villages must be an array')
  if (records.length > QUERY_LIMITS.botVillageProvisionBatch) {
    throw new RangeError(`bot villages may not exceed ${QUERY_LIMITS.botVillageProvisionBatch}`)
  }
  const ids = new Set<string>()
  const coordinates = new Set<string>()
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || typeof record.worldId !== 'string') {
      throw new RangeError('Every bot village must have an identity and world')
    }
    const coordinate = `${record.worldId}\u0000${record.x}\u0000${record.y}`
    if (ids.has(record.id) || coordinates.has(coordinate)) {
      throw new RangeError('Bot village provision batches may not contain duplicate identities or coordinates')
    }
    ids.add(record.id)
    coordinates.add(coordinate)
  }
  return [...records]
}

export function boundAdminPlayerQuery(query: AdminPlayerQuery): AdminPlayerQuery {
  if (typeof query.search !== 'string' || query.search.length > 64) {
    throw new RangeError('Admin player search may not exceed 64 characters')
  }
  if (!(query.now instanceof Date) || !Number.isFinite(query.now.getTime())
    || !(query.onlineSince instanceof Date) || !Number.isFinite(query.onlineSince.getTime())) {
    throw new RangeError('Admin player query timestamps must be valid Dates')
  }
  return { ...query, limit: boundedLimit(query.limit, QUERY_LIMITS.adminPlayers) }
}

export function boundAdminAttackQuery(query: AdminAttackQuery): AdminAttackQuery {
  if (query.state !== null && ![
    'preparing', 'engaged', 'active', 'finalizing', 'settled', 'cancelled', 'expired'
  ].includes(query.state)) throw new RangeError('Unknown admin attack state')
  return { ...query, limit: boundedLimit(query.limit, QUERY_LIMITS.adminAttacks) }
}

export function boundedLimit(value: number, maximum: number, name = 'limit'): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return Math.min(value, maximum)
}

function safeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} must be a safe integer`)
  return value
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`)
  }
  return value
}

export function boundAttackCandidateQuery(query: AttackCandidateQuery): AttackCandidateQuery {
  const trophyRadius = safeInteger(query.trophyRadius, 'trophyRadius')
  if (trophyRadius < 0 || trophyRadius > QUERY_LIMITS.trophyRadius) {
    throw new RangeError(`trophyRadius must be between 0 and ${QUERY_LIMITS.trophyRadius}`)
  }
  const targetTrophies = safeInteger(query.targetTrophies, 'targetTrophies')
  if (targetTrophies < 0 || targetTrophies > 2_147_483_647) {
    throw new RangeError('targetTrophies must fit a non-negative PostgreSQL integer')
  }
  return {
    ...query,
    targetTrophies,
    trophyRadius,
    now: validDate(query.now, 'now'),
    limit: boundedLimit(query.limit, QUERY_LIMITS.attackCandidates)
  }
}

export function boundAttackCommandQuery(query: AttackCommandQuery): AttackCommandQuery {
  const afterSequence = safeInteger(query.afterSequence, 'afterSequence')
  if (afterSequence < 0) throw new RangeError('afterSequence must be non-negative')
  if (!query.attackId) throw new RangeError('attackId is required')
  return {
    ...query,
    afterSequence,
    limit: boundedLimit(query.limit, QUERY_LIMITS.attackCommands)
  }
}

export function boundAttackPlayerBatch(
  playerIds: readonly string[],
  requestedLimit: number
): { playerIds: string[]; limit: number } {
  if (!Array.isArray(playerIds)) throw new RangeError('playerIds must be an array')
  if (playerIds.length > QUERY_LIMITS.attackPlayerIds) {
    throw new RangeError(`playerIds may not exceed ${QUERY_LIMITS.attackPlayerIds}`)
  }
  const unique = [...new Set(playerIds)]
  if (unique.some(playerId => typeof playerId !== 'string' || playerId.length < 1 || playerId.length > 160)) {
    throw new RangeError('Every playerId must contain 1-160 characters')
  }
  return {
    playerIds: unique,
    limit: boundedLimit(requestedLimit, QUERY_LIMITS.activeAttackBatch)
  }
}

export function boundWorldAtlasQuery(query: WorldAtlasQuery): WorldAtlasQuery {
  const minX = safeInteger(query.minX, 'minX')
  const maxX = safeInteger(query.maxX, 'maxX')
  const minY = safeInteger(query.minY, 'minY')
  const maxY = safeInteger(query.maxY, 'maxY')
  for (const [name, value] of [['minX', minX], ['maxX', maxX], ['minY', minY], ['maxY', maxY]] as const) {
    if (value < -2_147_483_648 || value > 2_147_483_647) {
      throw new RangeError(`${name} must fit a PostgreSQL integer`)
    }
  }
  if (minX > maxX || minY > maxY) throw new RangeError('World atlas bounds are inverted')
  if (maxX - minX + 1 > QUERY_LIMITS.worldAtlasSpan
    || maxY - minY + 1 > QUERY_LIMITS.worldAtlasSpan) {
    throw new RangeError(`World atlas spans may not exceed ${QUERY_LIMITS.worldAtlasSpan} plots per axis`)
  }
  return {
    ...query,
    minX,
    maxX,
    minY,
    maxY,
    now: validDate(query.now, 'now'),
    limit: boundedLimit(query.limit, QUERY_LIMITS.worldAtlas)
  }
}

export function boundWorldPlayerDirectoryQuery(
  query: WorldPlayerDirectoryQuery
): WorldPlayerDirectoryQuery {
  const centerX = safeInteger(query.centerX, 'centerX')
  const centerY = safeInteger(query.centerY, 'centerY')
  for (const [name, value] of [['centerX', centerX], ['centerY', centerY]] as const) {
    if (value < -2_147_483_648 || value > 2_147_483_647) {
      throw new RangeError(`${name} must fit a PostgreSQL integer`)
    }
  }
  return {
    ...query,
    centerX,
    centerY,
    now: validDate(query.now, 'now'),
    limit: boundedLimit(query.limit, QUERY_LIMITS.worldAtlas)
  }
}

export function boundWorldOccupancyBatch(
  coordinates: readonly { x: number; y: number }[]
): Array<{ x: number; y: number }> {
  if (!Array.isArray(coordinates)) throw new RangeError('coordinates must be an array')
  if (coordinates.length > QUERY_LIMITS.worldOccupancyBatch) {
    throw new RangeError(`coordinates may not exceed ${QUERY_LIMITS.worldOccupancyBatch}`)
  }
  const unique = new Map<string, { x: number; y: number }>()
  for (const coordinate of coordinates) {
    const x = safeInteger(coordinate?.x, 'coordinate.x')
    const y = safeInteger(coordinate?.y, 'coordinate.y')
    if (x < -2_147_483_648 || x > 2_147_483_647 || y < -2_147_483_648 || y > 2_147_483_647) {
      throw new RangeError('occupancy coordinates must fit PostgreSQL integers')
    }
    unique.set(`${x},${y}`, { x, y })
  }
  return [...unique.values()]
}

export function boundParticipantReplayQuery(query: ParticipantReplayQuery): ParticipantReplayQuery {
  const afterSequence = safeInteger(query.afterSequence, 'afterSequence')
  if (afterSequence < -1) throw new RangeError('afterSequence must be at least -1')
  return {
    ...query,
    afterSequence,
    limit: boundedLimit(query.limit, QUERY_LIMITS.replayChunks)
  }
}

export function boundNotificationQuery(query: NotificationQuery): NotificationQuery {
  if (query.before) {
    validDate(query.before.occurredAt, 'before.occurredAt')
    if (!query.before.id) throw new RangeError('before.id is required')
  }
  return {
    ...query,
    limit: boundedLimit(query.limit, QUERY_LIMITS.notifications)
  }
}
