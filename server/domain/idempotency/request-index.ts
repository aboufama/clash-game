export interface RequestReplayMarker {
  aggregateId: string
  createdAt: number
}

/**
 * Bounded compatibility index for the legacy JSON runtime. PostgreSQL uses
 * the durable idempotency table; this removes O(all attacks) request retries
 * while JSON remains available for local development and cutover validation.
 */
export class RequestReplayIndex {
  private readonly markers = new Map<string, RequestReplayMarker>()
  private readonly ttlMs: number
  private readonly maximumEntries: number

  constructor(options: { ttlMs?: number; maximumEntries?: number } = {}) {
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs ?? 24 * 60 * 60_000))
    this.maximumEntries = Math.max(1, Math.floor(options.maximumEntries ?? 200_000))
  }

  static key(operation: string, actorId: string, requestId: string): string {
    return `${operation}\u0000${actorId}\u0000${requestId}`
  }

  get(operation: string, actorId: string, requestId: string, now = Date.now()): string | undefined {
    if (!requestId) return undefined
    const key = RequestReplayIndex.key(operation, actorId, requestId)
    const marker = this.markers.get(key)
    if (!marker) return undefined
    if (now - marker.createdAt >= this.ttlMs) {
      this.markers.delete(key)
      return undefined
    }
    return marker.aggregateId
  }

  set(operation: string, actorId: string, requestId: string, aggregateId: string, createdAt = Date.now()): void {
    if (!requestId || !aggregateId) return
    const key = RequestReplayIndex.key(operation, actorId, requestId)
    if (!this.markers.has(key)) this.markers.set(key, { aggregateId, createdAt })
    if (this.markers.size > this.maximumEntries) this.prune(createdAt)
  }

  /** Removes retry markers owned by deleted actors or pointing at deleted aggregates. */
  deleteReferences(input: {
    actorIds?: ReadonlySet<string>
    aggregateIds?: ReadonlySet<string>
  }): number {
    let deleted = 0
    for (const [key, marker] of this.markers) {
      const firstSeparator = key.indexOf('\u0000')
      const secondSeparator = key.indexOf('\u0000', firstSeparator + 1)
      const actorId = firstSeparator >= 0 && secondSeparator > firstSeparator
        ? key.slice(firstSeparator + 1, secondSeparator)
        : ''
      if (input.actorIds?.has(actorId) || input.aggregateIds?.has(marker.aggregateId)) {
        this.markers.delete(key)
        deleted += 1
      }
    }
    return deleted
  }

  /** Drops every legacy retry marker after a system-wide authority reset. */
  clear(): number {
    const deleted = this.markers.size
    this.markers.clear()
    return deleted
  }

  get size(): number {
    return this.markers.size
  }

  prune(now = Date.now()): void {
    for (const [key, marker] of this.markers) {
      if (now - marker.createdAt >= this.ttlMs) this.markers.delete(key)
    }
    while (this.markers.size > this.maximumEntries) {
      const oldest = this.markers.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.markers.delete(oldest)
    }
  }
}
