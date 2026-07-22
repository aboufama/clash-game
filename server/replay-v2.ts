import { ApiError } from './errors'
import type {
  ReplayFrame,
  ReplayV2Chunk,
  ReplayV2CombatEvent,
  ReplayV2CombatEventType
} from './protocol'

export const MAX_REPLAY_V2_CHUNKS_PER_PUSH = 128
export const MAX_REPLAY_V2_SEQUENCE = 1_000_000
export const MAX_REPLAY_V2_EVENT_PAYLOAD_BYTES = 64 * 1024

const EVENT_TYPES = new Set<ReplayV2CombatEventType>([
  'troop.spawn',
  'combat.attack',
  'defense.charge',
  'defense.fire',
  'projectile.launch',
  'projectile.impact',
  'combat.damage',
  'combat.heal',
  'entity.death',
  'building.destroy',
  'ability',
  'status',
  'fx',
  'sound'
])

function safeId(raw: unknown, label: string, maximum = 120): string {
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > maximum || !/^[a-zA-Z0-9_.:-]+$/.test(raw)) {
    throw new ApiError(400, `${label} must be a safe identifier`)
  }
  return raw
}

function boundedInteger(raw: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
    throw new ApiError(400, `${label} must be an integer from ${minimum} to ${maximum}`)
  }
  return raw
}

function combatEvent(raw: unknown): ReplayV2CombatEvent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'Replay-v2 event must be an object')
  }
  const source = raw as Record<string, unknown>
  if (typeof source.type !== 'string' || !EVENT_TYPES.has(source.type as ReplayV2CombatEventType)) {
    throw new ApiError(400, 'Replay-v2 event type is unsupported')
  }
  if (source.version !== 1) throw new ApiError(400, 'Replay-v2 event version is unsupported')
  const seed = boundedInteger(source.seed, 'replayV2.event.seed', 0, 0xffff_ffff)
  if (!source.payload || typeof source.payload !== 'object' || Array.isArray(source.payload)) {
    throw new ApiError(400, 'Replay-v2 event payload must be an object')
  }
  let payload: Record<string, unknown>
  try {
    const serialized = JSON.stringify(source.payload)
    if (Buffer.byteLength(serialized, 'utf8') > MAX_REPLAY_V2_EVENT_PAYLOAD_BYTES) {
      throw new ApiError(400, 'Replay-v2 event payload is too large')
    }
    payload = JSON.parse(serialized) as Record<string, unknown>
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(400, 'Replay-v2 event payload must be JSON-safe')
  }
  const event: ReplayV2CombatEvent = {
    version: 1,
    id: safeId(source.id, 'replayV2.event.id', 160),
    seed,
    type: source.type as ReplayV2CombatEventType,
    payload
  }
  return event
}

export type ReplayFrameSanitizer = (raw: unknown, maxT: number) => ReplayFrame | null

export function replayV2Chunks(
  rawBatch: unknown,
  maxT: number,
  sanitizeFrame: ReplayFrameSanitizer
): ReplayV2Chunk[] {
  if (rawBatch === undefined) return []
  if (!rawBatch || typeof rawBatch !== 'object' || Array.isArray(rawBatch)) {
    throw new ApiError(400, 'replayV2 must be an object')
  }
  const rawChunks = (rawBatch as { chunks?: unknown }).chunks
  if (!Array.isArray(rawChunks)) throw new ApiError(400, 'replayV2.chunks must be an array')
  if (rawChunks.length > MAX_REPLAY_V2_CHUNKS_PER_PUSH) {
    throw new ApiError(400, `Replay-v2 batches may contain at most ${MAX_REPLAY_V2_CHUNKS_PER_PUSH} chunks`)
  }
  const chunks = rawChunks.map((raw, index): ReplayV2Chunk => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ApiError(400, `replayV2.chunks[${index}] must be an object`)
    }
    const source = raw as Record<string, unknown>
    const sequence = boundedInteger(source.sequence, `replayV2.chunks[${index}].sequence`, 1, MAX_REPLAY_V2_SEQUENCE)
    const t = boundedInteger(source.t, `replayV2.chunks[${index}].t`, 0, maxT)
    if (source.kind === 'event') {
      return { kind: 'event', sequence, t, event: combatEvent(source.event) }
    }
    if (source.kind === 'keyframe') {
      const frame = sanitizeFrame(source.frame, maxT)
      if (!frame) throw new ApiError(400, 'Replay-v2 correction keyframe is invalid')
      if (frame.t !== t) throw new ApiError(400, 'Replay-v2 keyframe time must match its frame time')
      return {
        kind: 'keyframe',
        sequence,
        t,
        ...(source.terminal === true ? { terminal: true } : {}),
        frame
      }
    }
    throw new ApiError(400, `replayV2.chunks[${index}].kind is unsupported`)
  })
  for (let index = 1; index < chunks.length; index += 1) {
    if (chunks[index]!.sequence !== chunks[index - 1]!.sequence + 1) {
      throw new ApiError(400, 'Replay-v2 chunk sequences must be contiguous and ordered')
    }
    if (chunks[index]!.t < chunks[index - 1]!.t) {
      throw new ApiError(400, 'Replay-v2 chunk times must be monotonic')
    }
  }
  const terminalIndex = chunks.findIndex(chunk => chunk.kind === 'keyframe' && chunk.terminal === true)
  if (terminalIndex >= 0 && terminalIndex !== chunks.length - 1) {
    throw new ApiError(400, 'Replay-v2 terminal keyframe must be the final chunk')
  }
  return chunks
}
