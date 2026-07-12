/**
 * Dense O(1) player-id directory used by bounded server-side selectors.
 *
 * It deliberately stores identifiers, not mutable player aggregates. Domain
 * callers resolve the current record and apply live eligibility rules. This
 * keeps matchmaking from allocating/scanning every account on each request.
 */
export class PlayerDirectory {
  private readonly ids: string[] = []
  private readonly positions = new Map<string, number>()

  get size(): number {
    return this.ids.length
  }

  add(id: string): boolean {
    if (!id || this.positions.has(id)) return false
    this.positions.set(id, this.ids.length)
    this.ids.push(id)
    return true
  }

  remove(id: string): boolean {
    const index = this.positions.get(id)
    if (index === undefined) return false
    const lastIndex = this.ids.length - 1
    const last = this.ids[lastIndex]
    this.ids.pop()
    this.positions.delete(id)
    if (index !== lastIndex) {
      this.ids[index] = last
      this.positions.set(last, index)
    }
    return true
  }

  has(id: string): boolean {
    return this.positions.has(id)
  }

  /**
   * Probe distinct ids from a randomized point without copying the directory.
   * Small worlds are scanned completely; MMO-sized worlds have a strict work
   * budget. Callers may retain several eligible results and choose among them.
   */
  probe(options: {
    exclude?: string
    limit?: number
    random?: () => number
  } = {}): string[] {
    const count = this.ids.length
    if (count === 0) return []
    const limit = Math.min(count, Math.max(1, Math.floor(options.limit ?? 2_048)))
    const random = options.random ?? Math.random
    const raw = random()
    const normalized = Number.isFinite(raw) ? Math.max(0, Math.min(0.999999999999, raw)) : 0
    const start = Math.floor(normalized * count)
    const found: string[] = []
    for (let offset = 0; offset < count && found.length < limit; offset += 1) {
      const id = this.ids[(start + offset) % count]
      if (id !== options.exclude) found.push(id)
    }
    return found
  }
}
