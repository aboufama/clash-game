import { createHash } from 'node:crypto'

/** Coordinate-scoped identity: finite seed collisions can never alias two bases. */
export function persistentBotVillageIdAt(worldId: string, x: number, y: number): string {
  const digest = createHash('sha256').update(`${worldId}\u0000${x}\u0000${y}`).digest('hex').slice(0, 24)
  return `bot_${digest}`
}
