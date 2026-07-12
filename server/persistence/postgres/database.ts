import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg'
import type { TransactionOptions } from '../model'

export interface SqlExecutor {
  query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>
}

export interface SqlDatabase {
  withTransaction<T>(work: (transaction: SqlExecutor) => Promise<T>, options?: TransactionOptions): Promise<T>
  close(): Promise<void>
}

const ISOLATION_SQL = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE'
} as const

function retryable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false
  return error.code === '40001' || error.code === '40P01'
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK')
  } catch {
    // Preserve the original failure. The pool will discard a broken connection.
  }
}

export class PostgresDatabase implements SqlDatabase {
  private readonly pool: Pool

  constructor(config: PoolConfig | Pool) {
    this.pool = config instanceof Pool ? config : new Pool(config)
    this.pool.on('error', error => {
      console.error('[database] idle PostgreSQL connection failed', error)
    })
  }

  async withTransaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
    options: TransactionOptions = {}
  ): Promise<T> {
    const isolation = options.isolation ?? 'serializable'
    const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? 2))
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.pool.connect()
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${ISOLATION_SQL[isolation]}`)
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await rollback(client)
        if (!retryable(error) || attempt >= maxRetries) throw error
      } finally {
        client.release()
      }
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Production configuration is explicit; absence of DATABASE_URL is never silently accepted. */
export function postgresFromEnvironment(environment: NodeJS.ProcessEnv = process.env): PostgresDatabase {
  const connectionString = environment.DATABASE_URL?.trim()
  if (!connectionString) throw new Error('DATABASE_URL is required')
  return new PostgresDatabase({
    connectionString,
    max: positiveInteger(environment.DATABASE_POOL_MAX, 20),
    connectionTimeoutMillis: positiveInteger(environment.DATABASE_CONNECT_TIMEOUT_MS, 5_000),
    idleTimeoutMillis: positiveInteger(environment.DATABASE_IDLE_TIMEOUT_MS, 30_000),
    application_name: environment.DATABASE_APPLICATION_NAME?.trim() || 'clash-game'
  })
}

export function postgresErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null
}
