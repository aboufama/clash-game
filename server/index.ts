import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createApiMiddleware, createGameServer } from './node-adapter'
import {
  PostgresPersistence,
  migrate,
  postgresFromEnvironment
} from './persistence'
import { PersistenceGameService } from './runtime/service'
import { createPersistenceAttackService } from './runtime/attack-service'

const PORT = Number(process.env.PORT) || 8787
const DIST_DIR = path.resolve(process.cwd(), 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
}

function serveStatic(urlPath: string, res: http.ServerResponse) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '')
  let filePath = path.join(DIST_DIR, safePath)
  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403).end()
    return
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html') // SPA fallback
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found — run "npm run build" first')
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
}

interface AuthorityRuntime {
  name: 'postgres' | 'legacy-json'
  middleware: ReturnType<typeof createApiMiddleware>
  flush(): boolean | Promise<boolean>
  close(): boolean | Promise<boolean>
}

async function createAuthorityRuntime(): Promise<AuthorityRuntime> {
  const mode = process.env.CLASH_STORAGE_MODE?.trim().toLowerCase()
  if (mode && mode !== 'postgres' && mode !== 'json' && mode !== 'legacy-json') {
    throw new Error('CLASH_STORAGE_MODE must be "postgres" or "legacy-json"')
  }
  const usePostgres = mode === 'postgres' || (!mode && Boolean(process.env.DATABASE_URL?.trim()))
  if (usePostgres) {
    // A requested database runtime fails closed. It never falls through to a
    // local JSON writer if configuration, migration, or connectivity fails.
    const database = postgresFromEnvironment()
    try {
      await migrate(database)
      const persistence = new PostgresPersistence(database)
      const attacks = createPersistenceAttackService(persistence)
      const service = new PersistenceGameService(persistence, { attacks })
      let maintenanceRunning = false
      const runMaintenance = async () => {
        if (maintenanceRunning) return
        maintenanceRunning = true
        try {
          const runJob = async (name: string, job: () => Promise<unknown>) => {
            try {
              await job()
            } catch (error) {
              console.error(`[maintenance] ${name} failed:`, error)
            }
          }
          await runJob('expired guest lease sweep', () => service.sweepExpiredGuestLeases(50))
          await runJob('auxiliary retention sweep', () => service.sweepRetention(500))
          await runJob('due attack sweep', () => attacks.sweepDueAttacks(50))
        } finally {
          maintenanceRunning = false
        }
      }
      const maintenance = setInterval(() => { void runMaintenance() }, 30_000)
      maintenance.unref()
      void runMaintenance()
      return {
        name: 'postgres',
        middleware: createApiMiddleware(service),
        flush: () => true,
        close: async () => {
          clearInterval(maintenance)
          await service.close()
          return true
        }
      }
    } catch (error) {
      await database.close()
      throw error
    }
  }

  const explicitLocalCompatibility = mode === 'json' || mode === 'legacy-json'
    || Boolean(process.env.CLASH_DATA_DIR?.trim())
  if (!explicitLocalCompatibility) {
    throw new Error(
      'No storage authority selected. Set DATABASE_URL/CLASH_STORAGE_MODE=postgres, '
      + 'or opt into local compatibility with CLASH_STORAGE_MODE=legacy-json.'
    )
  }
  const legacy = createGameServer()
  return { name: 'legacy-json', ...legacy }
}

const { name: authorityName, middleware, flush, close } = await createAuthorityRuntime()

const server = http.createServer((req, res) => {
  void middleware(req, res).then(handled => {
    if (!handled) serveStatic(new URL(req.url ?? '/', 'http://localhost').pathname, res)
  }).catch(error => {
    console.error('[server] request failed:', error)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

server.listen(PORT, () => {
  console.log(`Clash server running at http://localhost:${PORT} (${authorityName} authority + static dist/)`)
})

let shuttingDown = false
let finalized = false
async function finalize(): Promise<void> {
  if (finalized) return
  finalized = true
  let saved = false
  try {
    saved = await flush()
    saved = await close() && saved
  } catch (error) {
    console.error('[server] shutdown failed:', error)
  }
  process.exit(saved ? 0 : 1)
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  void Promise.resolve(flush()).catch(error => console.error('[server] pre-drain flush failed:', error))
  server.close(() => { void finalize() })
  setTimeout(() => { void finalize() }, 1_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
