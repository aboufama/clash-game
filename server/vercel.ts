// Build this entrypoint to api/server.mjs for Vercel's Node runtime.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createApiMiddleware } from '../server/node-adapter'
import {
  PostgresPersistence,
  postgresFromEnvironment
} from '../server/persistence'
import { createPersistenceAttackService } from '../server/runtime/attack-service'
import { PersistenceGameService } from '../server/runtime/service'

interface ServerlessRuntime {
  middleware: ReturnType<typeof createApiMiddleware>
  runMaintenance(): Promise<Record<string, unknown>>
}

let runtimePromise: Promise<ServerlessRuntime> | null = null

async function createServerlessRuntime(): Promise<ServerlessRuntime> {
  // Each warm function instance owns a pool. Keep its default deliberately
  // small so horizontal function scaling cannot exhaust a managed database.
  const database = postgresFromEnvironment({
    ...process.env,
    DATABASE_POOL_MAX: process.env.DATABASE_POOL_MAX?.trim() || '3',
    DATABASE_APPLICATION_NAME: process.env.DATABASE_APPLICATION_NAME?.trim() || 'clash-game-vercel'
  })

  try {
    const persistence = new PostgresPersistence(database)
    const attacks = createPersistenceAttackService(persistence)
    const service = new PersistenceGameService(persistence, { attacks })

    return {
      middleware: createApiMiddleware(service),
      async runMaintenance() {
        const startedAt = Date.now()
        const results = await Promise.allSettled([
          service.sweepExpiredGuestLeases(50),
          service.sweepRetention(500),
          attacks.sweepDueAttacks(50),
          service.preprovisionBotVillages(25)
        ])
        for (const result of results) {
          if (result.status === 'rejected') console.error('[maintenance] serverless sweep failed:', result.reason)
        }
        return {
          ok: results.every(result => result.status === 'fulfilled'),
          durationMs: Date.now() - startedAt,
          guests: results[0]?.status === 'fulfilled' ? results[0].value : null,
          retention: results[1]?.status === 'fulfilled' ? results[1].value : null,
          attacks: results[2]?.status === 'fulfilled' ? results[2].value : null,
          bots: results[3]?.status === 'fulfilled' ? results[3].value : null
        }
      }
    }
  } catch (error) {
    await database.close()
    throw error
  }
}

function cronAuthorized(request: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET?.trim()
  if (!secret) return false
  const raw = request.headers.authorization
  const authorization = Array.isArray(raw) ? raw[0] : raw
  if (!authorization) return false
  const expected = `Bearer ${secret}`
  const actualBytes = Buffer.from(authorization)
  const expectedBytes = Buffer.from(expected)
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes)
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

function runtime(): Promise<ServerlessRuntime> {
  if (!runtimePromise) {
    runtimePromise = createServerlessRuntime().catch(error => {
      // A transient database outage must not poison a warm function forever.
      runtimePromise = null
      throw error
    })
  }
  return runtimePromise
}

export default async function handler(
  request: IncomingMessage & { body?: unknown },
  response: ServerResponse
): Promise<void> {
  try {
    // Plain Vite functions do not expand a filesystem catch-all filename over
    // multiple path segments. vercel.json forwards the original suffix as an
    // internal query parameter to the stable /api/server entrypoint.
    const forwarded = new URL(request.url ?? '/', 'http://localhost')
    const apiPath = forwarded.searchParams.get('__clash_path')
    if (apiPath !== null) {
      forwarded.searchParams.delete('__clash_path')
      const query = forwarded.searchParams.toString()
      request.url = `/api/${apiPath}${query ? `?${query}` : ''}`
    }

    const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname
    if (requestPath === '/api/internal/maintenance') {
      if (request.method !== 'GET') {
        jsonResponse(response, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' })
        return
      }
      if (!process.env.CRON_SECRET?.trim()) {
        jsonResponse(response, 503, { error: 'Maintenance cron is not configured', code: 'CRON_NOT_CONFIGURED' })
        return
      }
      if (!cronAuthorized(request)) {
        jsonResponse(response, 401, { error: 'Maintenance cron authorization failed', code: 'CRON_UNAUTHORIZED' })
        return
      }
      const current = await runtime()
      const result = await current.runMaintenance()
      jsonResponse(response, result.ok === true ? 200 : 500, result)
      return
    }

    const current = await runtime()
    const handled = await current.middleware(request, response)
    if (!handled && !response.headersSent) {
      response.statusCode = 404
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(JSON.stringify({ error: 'API route not found', code: 'NOT_FOUND' }))
    }
  } catch (error) {
    console.error('[serverless] game authority unavailable:', error)
    if (!response.headersSent) {
      response.statusCode = 503
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(JSON.stringify({
        error: 'The game server is temporarily unavailable',
        code: 'GAME_SERVER_UNAVAILABLE'
      }))
    } else {
      response.end()
    }
  }
}
