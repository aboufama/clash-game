import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiMiddleware } from '../server/node-adapter'
import {
  PostgresPersistence,
  migrate,
  postgresFromEnvironment
} from '../server/persistence'
import { createPersistenceAttackService } from '../server/runtime/attack-service'
import { PersistenceGameService } from '../server/runtime/service'

interface ServerlessRuntime {
  middleware: ReturnType<typeof createApiMiddleware>
  runMaintenance(): void
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
    await migrate(database)
    const persistence = new PostgresPersistence(database)
    const attacks = createPersistenceAttackService(persistence)
    const service = new PersistenceGameService(persistence, { attacks })
    let maintenanceRunning = false
    let lastMaintenanceAt = 0

    return {
      middleware: createApiMiddleware(service),
      runMaintenance() {
        const now = Date.now()
        if (maintenanceRunning || now - lastMaintenanceAt < 30_000) return
        maintenanceRunning = true
        lastMaintenanceAt = now
        void Promise.allSettled([
          service.sweepExpiredGuestLeases(50),
          service.sweepRetention(500),
          attacks.sweepDueAttacks(50)
        ]).then(results => {
          for (const result of results) {
            if (result.status === 'rejected') console.error('[maintenance] serverless sweep failed:', result.reason)
          }
        }).finally(() => {
          maintenanceRunning = false
        })
      }
    }
  } catch (error) {
    await database.close()
    throw error
  }
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
    const current = await runtime()
    const handled = await current.middleware(request, response)
    if (!handled && !response.headersSent) {
      response.statusCode = 404
      response.setHeader('Content-Type', 'application/json; charset=utf-8')
      response.setHeader('Cache-Control', 'no-store')
      response.end(JSON.stringify({ error: 'API route not found', code: 'NOT_FOUND' }))
    }
    current.runMaintenance()
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
