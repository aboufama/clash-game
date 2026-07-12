import { randomBytes } from 'node:crypto'

/** Collision-resistant ids for runtime-owned aggregates and audit operations. */
export function randomId(prefix: string, bytes = 8): string {
  return `${prefix}_${randomBytes(bytes).toString('hex')}`
}
