import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Directory-backed JSON collection. All records live in memory (the server is
 * the single authority); writes are debounced and atomic (tmp file + rename),
 * so a crash mid-write can never corrupt an existing record.
 */
export class JsonCollection<T> {
  private readonly dir: string
  private readonly records = new Map<string, T>()
  private readonly dirty = new Set<string>()
  private readonly deleting = new Set<string>()
  private readonly flushDelayMs: number
  private flushTimer: NodeJS.Timeout | null = null

  constructor(dataRoot: string, name: string, flushDelayMs = 150) {
    this.flushDelayMs = flushDelayMs
    this.dir = path.join(dataRoot, name)
    mkdirSync(this.dir, { recursive: true })
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith('.tmp')) {
        // A crash can leave only the unpublished temp file behind. It was
        // never committed by rename, so it is safe to discard on startup.
        try { rmSync(path.join(this.dir, file), { force: true }) } catch { /* best effort */ }
        continue
      }
      if (!file.endsWith('.json')) continue
      const id = file.slice(0, -'.json'.length)
      try {
        this.records.set(id, JSON.parse(readFileSync(path.join(this.dir, file), 'utf8')) as T)
      } catch (error) {
        console.warn(`[store] skipping unreadable record ${name}/${file}:`, error)
      }
    }
  }

  private static isSafeId(id: string) {
    return /^[a-zA-Z0-9_-]{1,120}$/.test(id)
  }

  get(id: string): T | undefined {
    return this.records.get(id)
  }


  values(): IterableIterator<T> {
    return this.records.values()
  }

  entries(): IterableIterator<[string, T]> {
    return this.records.entries()
  }

  get size(): number {
    return this.records.size
  }

  /** Insert or replace a record and schedule it for persistence. */
  set(id: string, value: T): void {
    if (!JsonCollection.isSafeId(id)) throw new Error(`Unsafe record id: ${id}`)
    this.deleting.delete(id)
    this.records.set(id, value)
    this.markDirty(id)
  }

  /** Re-persist a record mutated in place. */
  markDirty(id: string): void {
    if (!this.records.has(id)) return
    this.dirty.add(id)
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs)
      this.flushTimer.unref?.()
    }
  }

  delete(id: string): boolean {
    if (!this.records.has(id)) return this.deleting.has(id) ? this.flushOne(id) : true
    this.records.delete(id)
    this.dirty.delete(id)
    this.deleting.add(id)
    const deleted = this.flushOne(id)
    if (!deleted) this.armFlushTimer()
    return deleted
  }

  private filePath(id: string) {
    return path.join(this.dir, `${id}.json`)
  }

  /** Persist directory-entry changes (rename/unlink), not only file bytes. */
  private syncDirectory(): void {
    let fd: number | null = null
    try {
      fd = openSync(this.dir, 'r')
      fsyncSync(fd)
    } catch (error) {
      // Some filesystems/platforms do not support fsync on directories. File
      // fsync + atomic rename still protects record contents there.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error
    } finally {
      if (fd !== null) closeSync(fd)
    }
  }

  private writeRecord(id: string): void {
    const value = this.records.get(id)
    if (value === undefined) return
    const target = this.filePath(id)
    const tmp = `${target}.tmp`
    let fd: number | null = null
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(value), 'utf8')
      fsyncSync(fd)
    } finally {
      if (fd !== null) closeSync(fd)
    }
    renameSync(tmp, target)
    this.syncDirectory()
  }

  private deleteRecord(id: string): void {
    rmSync(this.filePath(id), { force: true })
    this.syncDirectory()
  }

  private armFlushTimer(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => this.flush(), this.flushDelayMs)
    this.flushTimer.unref?.()
  }

  /** Persist one record synchronously without coupling success to unrelated dirty records. */
  flushOne(id: string): boolean {
    if (this.deleting.has(id)) {
      try {
        this.deleteRecord(id)
        this.deleting.delete(id)
        return true
      } catch (error) {
        console.error(`[store] delete flush failed for ${id}, will retry:`, error)
        this.armFlushTimer()
        return false
      }
    }
    if (!this.records.has(id) || !this.dirty.has(id)) return true
    try {
      this.writeRecord(id)
      this.dirty.delete(id)
      return true
    } catch (error) {
      console.error(`[store] flush failed for ${id}, will retry:`, error)
      return false
    }
  }

  /** Write every dirty record to disk. Synchronous by design: called from a timer or at shutdown. */
  flush(): boolean {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    // Only clear a record from the dirty set once its write actually succeeds, so a failed
    // write is retried on the next flush instead of being silently dropped.
    let ok = true
    for (const id of [...this.deleting]) {
      try {
        this.deleteRecord(id)
        this.deleting.delete(id)
      } catch (error) {
        ok = false
        console.error(`[store] delete flush failed for ${id}, will retry:`, error)
      }
    }
    for (const id of [...this.dirty]) {
      try {
        this.writeRecord(id)
        this.dirty.delete(id)
      } catch (error) {
        ok = false
        console.error(`[store] flush failed for ${id}, will retry:`, error)
      }
    }
    // If any writes failed, keep a timer armed so they get retried.
    if (this.dirty.size > 0 || this.deleting.size > 0) this.armFlushTimer()
    return ok && this.dirty.size === 0 && this.deleting.size === 0
  }
}
