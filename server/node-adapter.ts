import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { GameService } from './game'
import { bearerToken, createApiHandler } from './http'
import type { ApiService, Awaitable } from './runtime/contracts'

// Replay frames are deliberately compact. Refuse giant JSON bodies before
// parsing them so one request cannot briefly allocate tens of megabytes.
const MAX_BODY_BYTES = 2 * 1024 * 1024

function clientAddress(req: IncomingMessage): string {
  // Forwarded addresses are forgeable unless a trusted reverse proxy strips
  // and rewrites the header. Deployments opt in explicitly.
  const forwarded = process.env.CLASH_TRUST_PROXY === '1' ? req.headers['x-forwarded-for'] : undefined
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return (first || req.socket.remoteAddress || 'unknown').slice(0, 96)
}

function defaultDataRoot() {
  return process.env.CLASH_DATA_DIR || path.resolve(process.cwd(), 'server', 'data')
}

function syncDirectory(dir: string) {
  let fd: number | null = null
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * The JSON store assumes one in-memory authority. Enforce that assumption at
 * the data-directory boundary so a stray second Vite/production process can
 * never race atomic renames with a different snapshot.
 */
function acquireDataLease(dataRoot: string): { release: () => void } {
  mkdirSync(dataRoot, { recursive: true })
  const lockPath = path.join(dataRoot, '.clash-server.lock')
  const nonce = randomBytes(16).toString('hex')
  const record = JSON.stringify({ pid: process.pid, nonce, startedAt: Date.now() })

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | null = null
    let created = false
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      created = true
      writeFileSync(fd, record, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      syncDirectory(dataRoot)

      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          try {
            const current = JSON.parse(readFileSync(lockPath, 'utf8')) as { nonce?: unknown }
            if (current.nonce !== nonce) return
            rmSync(lockPath, { force: true })
            syncDirectory(dataRoot)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn('[server] could not release data-directory lease:', error)
            }
          }
        }
      }
    } catch (error) {
      if (fd !== null) closeSync(fd)
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') {
        if (created) {
          try { rmSync(lockPath, { force: true }) } catch { /* original error is more useful */ }
        }
        throw error
      }

      let holder: { pid?: unknown; startedAt?: unknown } = {}
      try {
        holder = JSON.parse(readFileSync(lockPath, 'utf8')) as typeof holder
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue
      }
      const holderPid = Number(holder.pid)
      if (processIsAlive(holderPid)) {
        throw new Error(`Data directory is already owned by live server process ${holderPid}: ${dataRoot}`)
      }
      // A dead PID (or malformed partial legacy lock) is stale. Exclusive
      // creation on the next loop still arbitrates simultaneous starters.
      try {
        rmSync(lockPath, { force: true })
        syncDirectory(dataRoot)
      } catch (removeError) {
        if ((removeError as NodeJS.ErrnoException).code !== 'ENOENT') throw removeError
      }
    }
  }
  throw new Error(`Could not acquire data-directory lease: ${dataRoot}`)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > MAX_BODY_BYTES) throw new Error('Request body too large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text)
}

/** Bind either synchronous compatibility authority or an async database service to node:http. */
export function createApiMiddleware<Principal>(
  game: ApiService<Principal>,
  flushDurably: () => Awaitable<boolean> = () => true
) {
  const handle = createApiHandler(game)
  const durableMutationWindows = new Map<string, { startedAt: number; count: number }>()
  const frameWindows = new Map<string, { startedAt: number; count: number }>()
  const configuredMutationLimit = Number(process.env.CLASH_AUTH_MUTATIONS_PER_10S ?? 40)
  const configuredFrameLimit = Number(process.env.CLASH_AUTH_FRAME_PUSHES_PER_10S ?? 100)
  const mutationLimit = Number.isFinite(configuredMutationLimit) ? Math.max(5, configuredMutationLimit) : 40
  const frameLimit = Number.isFinite(configuredFrameLimit) ? Math.max(20, configuredFrameLimit) : 100
  const takeBudget = (windows: Map<string, { startedAt: number; count: number }>, key: string, limit: number) => {
    const now = Date.now()
    let window = windows.get(key)
    if (!window || now - window.startedAt >= 10_000) {
      window = { startedAt: now, count: 0 }
      windows.set(key, window)
    }
    if (window.count >= limit) return false
    window.count += 1
    if (windows.size > 20_000) {
      for (const [oldKey, oldWindow] of windows) {
        if (now - oldWindow.startedAt >= 10_000) windows.delete(oldKey)
        if (windows.size <= 10_000) break
      }
    }
    return true
  }

  return async function middleware(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/api/')) return false

    const rawToken = bearerToken(req.headers.authorization)
    const address = clientAddress(req)
    const stateChanging = req.method === 'POST' || req.method === 'PUT'
      || req.method === 'PATCH' || req.method === 'DELETE'
    if (stateChanging && rawToken) {
      const tokenKey = createHash('sha256').update(rawToken).digest('hex')
      const isBattleStream = url.pathname === '/api/attacks/frames' || url.pathname === '/api/attacks/commands'
      const windows = isBattleStream ? frameWindows : durableMutationWindows
      const limit = isBattleStream ? frameLimit : mutationLimit
      const allowed = takeBudget(windows, `token:${tokenKey}`, limit)
        && takeBudget(windows, `address:${address}`, limit * 4)
      if (!allowed) {
        res.statusCode = 429
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('Retry-After', '10')
        res.end(JSON.stringify({ error: 'Too many authenticated mutations; retry shortly', code: 'RATE_LIMITED' }))
        return true
      }
    }

    let status = 500
    let payload: unknown = { error: 'Internal server error' }
    try {
      const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : undefined
      const result = await handle({
        method: req.method ?? 'GET',
        path: url.pathname.slice('/api'.length),
        query: url.searchParams,
        token: rawToken,
        clientAddress: address,
        body
      })
      status = result.status
      payload = result.body
      const requiresDurableFlush = stateChanging && url.pathname !== '/api/attacks/frames'
      if (status >= 200 && status < 300 && requiresDurableFlush && !await flushDurably()) {
        status = 503
        payload = { error: 'The server could not durably save that change', code: 'PERSISTENCE_FAILED' }
      }
    } catch (error) {
      status = 400
      payload = { error: error instanceof Error ? error.message : 'Bad request' }
    }

    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(payload))
    return true
  }
}

/**
 * Bind the pure API handler to node:http. Returns a connect-style middleware
 * usable both by the standalone server and by Vite's dev server, plus a flush
 * hook for graceful shutdown.
 */
export function createGameServer(dataRoot = defaultDataRoot()) {
  const resolvedRoot = path.resolve(dataRoot)
  const lease = acquireDataLease(resolvedRoot)
  let game: GameService
  try {
    game = new GameService(resolvedRoot)
  } catch (error) {
    lease.release()
    throw error
  }
  const middleware = createApiMiddleware(game, () => game.flush())

  let closed = false
  const flush = () => game.flush()
  const onExit = () => {
    if (closed) return
    try {
      game.flush()
    } finally {
      lease.release()
    }
  }
  process.once('exit', onExit)
  const close = () => {
    if (closed) return true
    let saved = false
    try {
      saved = game.flush()
      return saved
    } finally {
      lease.release()
      closed = true
      process.removeListener('exit', onExit)
    }
  }

  return { game, middleware, flush, close }
}
