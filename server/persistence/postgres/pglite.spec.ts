import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { QueryResult, QueryResultRow } from 'pg'
import { migrate } from '../migrations'
import { PostgresPersistence } from './persistence'
import type { SqlDatabase, SqlExecutor } from './database'
import { PersistenceGameService } from '../../runtime/service'
import { createPersistenceAttackService } from '../../runtime/attack-service'
import { outboxEvent } from '../repositories'
import { createApiMiddleware } from '../../node-adapter'
import { allocationOrdinalOf, nextPlotVersion } from '../../domain/world'

interface EmbeddedResult {
  rows: unknown[]
  affectedRows: number
}

interface EmbeddedQueryable {
  query(sql: string, parameters?: unknown[]): Promise<EmbeddedResult>
  exec?(sql: string): Promise<unknown>
}

function executor(queryable: EmbeddedQueryable): SqlExecutor {
  return {
    async query<Row extends QueryResultRow = QueryResultRow>(
      sql: string,
      values: readonly unknown[] = []
    ): Promise<QueryResult<Row>> {
      // node-postgres uses the simple protocol for parameterless multi-command
      // migration bodies. PGlite's query() always uses the extended protocol,
      // so route only those bodies through its equivalent simple exec().
      if (values.length === 0 && /;\s*\S/.test(sql) && queryable.exec) {
        await queryable.exec(sql)
        return { command: '', oid: 0, fields: [], rows: [], rowCount: 0 } as QueryResult<Row>
      }
      const result = await queryable.query(sql, [...values])
      return {
        command: '',
        oid: 0,
        fields: [],
        rows: result.rows as Row[],
        // PGlite reports affectedRows=0 for SELECT while node-postgres reports
        // the selected row count. Preserve node-postgres repository semantics.
        rowCount: result.affectedRows || result.rows.length
      } as QueryResult<Row>
    }
  }
}

class EmbeddedPostgres implements SqlDatabase {
  readonly raw = new PGlite()

  async withTransaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T> {
    return this.raw.transaction(transaction => work(executor(transaction as EmbeddedQueryable)))
  }

  async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []) {
    return executor(this.raw as EmbeddedQueryable).query<Row>(sql, values)
  }

  async close(): Promise<void> {
    await this.raw.close()
  }
}

const NOW = new Date('2026-07-11T18:00:00.000Z')
const DAY_MS = 86_400_000

interface HttpRequestOptions {
  method?: 'GET' | 'POST'
  token?: string
  body?: unknown
}

async function requestJson<T>(
  origin: string,
  path: string,
  options: HttpRequestOptions = {}
): Promise<T> {
  const response = await fetch(`${origin}/api${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' })
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const payload = await response.json() as T | { error?: unknown }
  assert.equal(
    response.status,
    200,
    `${options.method ?? 'GET'} /api${path}: ${JSON.stringify(payload)}`
  )
  return payload as T
}

async function listenEphemerally(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  const address = server.address() as AddressInfo | null
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
}

test('embedded PostgreSQL semantics cover migration, world, attack, replay, and retention paths', async () => {
  const database = new EmbeddedPostgres()
  await migrate(database)
  const persistence = new PostgresPersistence(database)
  const attacks = createPersistenceAttackService(persistence, { now: () => new Date(NOW) })
  const service = new PersistenceGameService(persistence, {
    attacks,
    starterShieldMs: 0,
    allowDebugGrants: true,
    now: () => new Date(NOW)
  })

  try {
    const first = await service.ensureSession('', 'pglite-a')
    const second = await service.ensureSession('', 'pglite-b')
    const third = await service.ensureSession('', 'pglite-c')
    const attacker = { playerId: first.player.id }

    // This path exercises region creation and PgWorld.assign. In particular,
    // it catches ambiguous integer/numeric inference in coordinate parameters.
    assert.notDeepEqual(
      [first.player.plotX, first.player.plotY],
      [second.player.plotX, second.player.plotY]
    )
    await service.applyResources(attacker, {
      delta: 2_000, reason: 'debug_grant', requestId: 'pglite-gold'
    })
    await service.applyResources(attacker, {
      resource: 'food', delta: 50, reason: 'debug_grant', requestId: 'pglite-food'
    })
    await service.trainTroop(attacker, { type: 'warrior', count: 2, requestId: 'pglite-train' })

    const started = await service.matchmake(attacker, {
      requestId: 'pglite-match',
      excludeTargetId: second.player.id
    }, first.token) as {
      attackId: string
      world: { ownerId: string }
    }
    assert.equal(started.world.ownerId, third.player.id)
    const command = await service.pushCommands(attacker, {
      attackId: started.attackId,
      commands: [{
        type: 'DEPLOY',
        commandId: 'pglite-deploy',
        sequence: 1,
        troopInstanceId: 'pglite-warrior',
        troopType: 'warrior',
        gridX: 2,
        gridY: 2
      }]
    }) as { phase: string }
    assert.equal(command.phase, 'ACTIVE')
    assert.deepEqual(await service.pushFrames(attacker, {
      attackId: started.attackId,
      frames: [{
        t: 0,
        destruction: 0,
        goldLooted: 0,
        oreLooted: 0,
        foodLooted: 0,
        buildings: [],
        troops: []
      }]
    }), { frameCount: 1 })

    // PostgreSQL JSONB removes undefined optional properties. Ending after the
    // finalization CAS must reload that canonical aggregate before settlement.
    await service.endAttack(attacker, { attackId: started.attackId, status: 'finished' })
    const authorityCounts = await database.query<{
      state: string
      commands: number
      settlements: number
      presentation_chunks: number
    }>(String.raw`
      SELECT attack.state,
        (SELECT count(*)::integer FROM attack_commands command WHERE command.attack_id = attack.id) AS commands,
        (SELECT count(*)::integer FROM attack_settlements settlement WHERE settlement.attack_id = attack.id) AS settlements,
        (SELECT count(*)::integer FROM replay_chunks chunk
          WHERE chunk.attack_id = attack.id AND chunk.format = 'presentation-frame-v1') AS presentation_chunks
      FROM attacks attack WHERE attack.id = $1
    `, [started.attackId])
    assert.deepEqual(authorityCounts.rows[0], {
      state: 'settled', commands: 1, settlements: 1, presentation_chunks: 1
    })

    const bot = await service.botStart(attacker, { requestId: 'pglite-bot-start' }, first.token) as {
      raidId: string
      x: number
      y: number
    }
    await service.pushCommands(attacker, {
      raidId: bot.raidId,
      commands: [{
        type: 'DEPLOY',
        commandId: 'pglite-bot-deploy',
        sequence: 1,
        troopInstanceId: 'pglite-bot-warrior',
        troopType: 'warrior',
        gridX: 2,
        gridY: 2
      }]
    })
    await service.botSettle(attacker, {
      raidId: bot.raidId,
      x: bot.x,
      y: bot.y,
      requestId: 'pglite-bot-settle',
      destruction: 100,
      deployed: { warrior: 99 }
    })
    const botAuthority = await database.query<{ target_kind: string; state: string; settlements: number }>(String.raw`
      SELECT attack.target_kind, attack.state,
        (SELECT count(*)::integer FROM attack_settlements settlement WHERE settlement.attack_id = attack.id) AS settlements
      FROM attacks attack WHERE attack.id = $1
    `, [bot.raidId])
    assert.deepEqual(botAuthority.rows[0], { target_kind: 'bot', state: 'settled', settlements: 1 })

    await service.map(attacker)
    await service.atlas(attacker)
    await service.leaderboard(attacker)
    await service.economyLedger(2)
    await attacks.sweepDueAttacks(10)

    await persistence.transaction(async tx => {
      for (let index = 0; index < 55; index += 1) {
        await tx.notifications.add({
          playerId: second.player.id,
          id: `pglite-notice-${String(index).padStart(2, '0')}`,
          eventType: 'attack',
          payload: { index },
          occurredAt: new Date(NOW.getTime() + index),
          readAt: null
        })
      }
      assert.equal((await tx.notifications.listForPlayer({
        playerId: second.player.id,
        limit: 100
      })).length, 50)

      for (const [playerId, balanceAfter] of [
        [first.player.id, 10],
        [second.player.id, 20]
      ] as const) {
        await tx.balanceLedger.append({
          playerId,
          operation: 'pglite-colliding-request',
          requestId: 'same-client-request-id',
          currency: 'gold',
          delta: 10,
          balanceAfter,
          metadata: {},
          createdAt: NOW
        })
      }
      const day = Math.floor(NOW.getTime() / DAY_MS)
      const collisionSummary = (await tx.balanceLedger.summarizeDays(day, day))
        .find(row => row.operation === 'pglite-colliding-request' && row.currency === 'gold')
      assert.equal(collisionSummary?.operationCount, 2)

      const old = new Date(NOW.getTime() - 10 * DAY_MS)
      await tx.idempotency.claim(second.player.id, 'old-operation', 'old-request', old, new Date(old.getTime() + 1_000))
      await tx.idempotency.complete(second.player.id, 'old-operation', 'old-request', { ok: true })
      await tx.operationMarkers.add(second.player.id, 'merchant', 'old-marker', old)
      const published = await tx.outbox.add(outboxEvent({
        topic: 'pglite',
        aggregateType: 'player',
        aggregateId: second.player.id,
        eventType: 'published-old',
        now: old
      }))
      const claimed = await tx.outbox.claimBatch('pglite-publisher', old, new Date(old.getTime() + 1_000), 1)
      assert.equal(claimed[0]?.id, published)
      assert.equal(await tx.outbox.markPublished(published, 'pglite-publisher', old), true)
      await tx.outbox.add(outboxEvent({
        topic: 'pglite',
        aggregateType: 'player',
        aggregateId: second.player.id,
        eventType: 'undelivered-old',
        now: old
      }))
    })
    assert.deepEqual(await service.sweepRetention(500), {
      idempotency: 1,
      outboxPublished: 1,
      outboxExpired: 1,
      operationMarkers: 1
    })

    await database.query('SET enable_seqscan = off')
    const explain = async (sql: string, values: readonly unknown[] = []) => (
      await database.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, values)
    ).rows.map(row => row['QUERY PLAN']).join('\n')
    assert.match(await explain(String.raw`
      SELECT player_id FROM world_plots
      WHERE world_id = $1 AND y BETWEEN $2 AND $3 AND x BETWEEN $4 AND $5
      ORDER BY y, x, player_id LIMIT $6
    `, ['main', -5, 5, -5, 5, 50]), /world_plots_atlas_window_idx/)
    assert.match(await explain(String.raw`
      SELECT player_id FROM world_plots
      WHERE world_id = $1 AND lease_expires_at <= $2
      ORDER BY lease_expires_at, player_id LIMIT $3
    `, ['main', NOW, 50]), /world_plots_guest_reaper_idx/)
    assert.match(await explain(String.raw`
      SELECT id FROM attacks
      WHERE state IN ('preparing', 'engaged', 'active', 'finalizing') AND deadline_at <= $1
      ORDER BY deadline_at, id LIMIT $2
    `, [NOW, 50]), /attacks_deadline_idx/)
    assert.match(await explain(String.raw`
      SELECT id FROM notifications WHERE player_id = $1
      ORDER BY occurred_at DESC, id DESC LIMIT $2
    `, [second.player.id, 50]), /notifications_history_page_idx/)
    assert.match(await explain(String.raw`
      SELECT actor_id FROM idempotency_keys WHERE expires_at <= $1
      ORDER BY expires_at LIMIT $2
    `, [NOW, 50]), /idempotency_expiry_idx/)
    assert.match(await explain(String.raw`
      SELECT id FROM outbox_events WHERE published_at <= $1
      ORDER BY published_at, id LIMIT $2
    `, [NOW, 50]), /outbox_published_retention_idx/)
    assert.match(await explain(String.raw`
      SELECT player_id FROM operation_markers WHERE observed_at < $1
      ORDER BY observed_at, player_id, kind, marker_key LIMIT $2
    `, [NOW, 50]), /operation_markers_retention_idx/)

    const migrationCount = await database.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM schema_migrations'
    )
    assert.equal(migrationCount.rows[0]?.count, 10)
  } finally {
    await service.close()
  }
})

test('embedded PostgreSQL serves the normalized authority through real node:http', async () => {
  // PGlite runs PostgreSQL in-process. This proves the actual HTTP adapter and
  // normalized SQL repositories together; networked PostgreSQL contention is
  // covered separately in deployment/load testing.
  const database = new EmbeddedPostgres()
  let service: PersistenceGameService | null = null
  let server: Server | null = null

  try {
    await migrate(database)
    const persistence = new PostgresPersistence(database)
    const attacks = createPersistenceAttackService(persistence, { now: () => new Date(NOW) })
    service = new PersistenceGameService(persistence, {
      attacks,
      starterShieldMs: 0,
      allowDebugGrants: true,
      now: () => new Date(NOW)
    })
    const middleware = createApiMiddleware(service)
    server = createServer((request, response) => {
      void middleware(request, response).then(handled => {
        if (handled) return
        response.statusCode = 404
        response.end()
      }).catch(error => {
        response.statusCode = 500
        response.end(error instanceof Error ? error.message : 'HTTP test failure')
      })
    })
    const origin = await listenEphemerally(server)

    assert.equal((await requestJson<{ ok: boolean }>(origin, '/health')).ok, true)
    const attacker = await requestJson<{
      token: string
      player: { id: string; plotX: number; plotY: number }
    }>(origin, '/auth/session', { method: 'POST', body: {} })
    const defender = await requestJson<{
      token: string
      player: { id: string; plotX: number; plotY: number }
    }>(origin, '/auth/session', { method: 'POST', body: {} })
    assert.notEqual(attacker.player.id, defender.player.id)

    const world = await requestJson<{ world: { ownerId: string } }>(origin, '/world', {
      token: attacker.token
    })
    assert.equal(world.world.ownerId, attacker.player.id)
    const map = await requestJson<{
      me: { x: number; y: number; shieldUntil: number }
      plots: Array<{ ownerId?: string }>
    }>(
      origin,
      `/map?x=${attacker.player.plotX}&y=${attacker.player.plotY}&r=1`,
      { token: attacker.token }
    )
    assert.deepEqual(map.me, {
      x: attacker.player.plotX,
      y: attacker.player.plotY,
      shieldUntil: NOW.getTime()
    })
    assert.ok(map.plots.some(plot => plot.ownerId === attacker.player.id))

    await requestJson(origin, '/resources/apply', {
      method: 'POST', token: attacker.token,
      body: { delta: 2_000, reason: 'debug_grant', requestId: 'http-pglite-gold' }
    })
    await requestJson(origin, '/resources/apply', {
      method: 'POST', token: attacker.token,
      body: { resource: 'food', delta: 50, reason: 'debug_grant', requestId: 'http-pglite-food' }
    })
    const trained = await requestJson<{ army: { warrior: number } }>(origin, '/army/train', {
      method: 'POST', token: attacker.token,
      body: { type: 'warrior', count: 2, requestId: 'http-pglite-train' }
    })
    assert.equal(trained.army.warrior, 2)

    const started = await requestJson<{ attackId: string; world: { ownerId: string } }>(
      origin,
      '/attacks/matchmake',
      {
        method: 'POST', token: attacker.token,
        body: {
          requestId: 'http-pglite-match',
          excludeTargetId: defender.player.id
        }
      }
    )
    // NEXT prefers a different target, but a one-opponent world remains playable.
    assert.equal(started.world.ownerId, defender.player.id)
    const commanded = await requestJson<{ phase: string }>(origin, '/attacks/commands', {
      method: 'POST', token: attacker.token,
      body: {
        attackId: started.attackId,
        commands: [{
          type: 'DEPLOY',
          commandId: 'http-pglite-deploy',
          sequence: 1,
          troopInstanceId: 'http-pglite-warrior',
          troopType: 'warrior',
          gridX: 2,
          gridY: 2
        }]
      }
    })
    assert.equal(commanded.phase, 'ACTIVE')
    await requestJson(origin, '/attacks/end', {
      method: 'POST', token: attacker.token,
      body: { attackId: started.attackId, status: 'finished' }
    })

    const durable = await database.query<{
      state: string
      sessions: number
      plots: number
      commands: number
      settlements: number
    }>(String.raw`
      SELECT attack.state,
        (SELECT count(*)::integer FROM sessions) AS sessions,
        (SELECT count(*)::integer FROM world_plots WHERE player_id IS NOT NULL) AS plots,
        (SELECT count(*)::integer FROM attack_commands command WHERE command.attack_id = attack.id) AS commands,
        (SELECT count(*)::integer FROM attack_settlements settlement WHERE settlement.attack_id = attack.id) AS settlements
      FROM attacks attack WHERE attack.id = $1
    `, [started.attackId])
    assert.deepEqual(durable.rows[0], {
      state: 'settled', sessions: 2, plots: 2, commands: 1, settlements: 1
    })
  } finally {
    try {
      if (server) await closeServer(server)
    } finally {
      if (service) await service.close()
      else await database.close()
    }
  }
})

test('embedded PostgreSQL keeps release, frontier, and guest-reaper fencing consistent', async () => {
  const database = new EmbeddedPostgres()
  await migrate(database)
  const persistence = new PostgresPersistence(database)
  let now = new Date(NOW)
  const service = new PersistenceGameService(persistence, { now: () => new Date(now) })

  try {
    const guest = await service.ensureSession('', 'pglite-world-fence')
    const before = await database.query<{ next_ordinal: string; revision: string }>(
      'SELECT next_ordinal::text, revision::text FROM world_allocation_state WHERE world_id = $1',
      ['main']
    )
    const coordinate = { x: guest.player.plotX, y: guest.player.plotY }
    const ordinal = allocationOrdinalOf(coordinate)

    // Model the dangerous ordering directly: an allocator sampled no free row,
    // then a release published one before that coordinate was assigned. The
    // assignment boundary must consume the newly visible row itself.
    await persistence.transaction(async tx => {
      assert.equal((await tx.world.getReleasedSlots('main', 1)).length, 0)
      const plot = (await tx.world.getPlayerPlot(guest.player.id, { forUpdate: true }))!
      assert.equal(await tx.world.release(plot.playerId), true)
      const reassignedVersion = nextPlotVersion(plot.plotVersion)
      await tx.world.putReleasedSlot({
        worldId: plot.worldId,
        ordinal,
        plotVersion: reassignedVersion,
        releasedAt: now
      })
      await tx.world.assign({ ...plot, plotVersion: reassignedVersion, assignedAt: now })
      assert.equal(await tx.world.getReleasedSlot(plot.worldId, ordinal), null)
    })

    now = new Date(now.getTime() + 8 * DAY_MS)
    assert.deepEqual(await service.sweepExpiredGuestLeases(50), { released: 1, archived: 1 })
    const afterReap = await database.query<{
      next_ordinal: string
      revision: string
      plots: number
      released: number
    }>(String.raw`
      SELECT allocation.next_ordinal::text, allocation.revision::text,
        (SELECT count(*)::integer FROM world_plots WHERE player_id = $2) AS plots,
        (SELECT count(*)::integer FROM world_released_slots
          WHERE world_id = $1 AND ordinal = $3) AS released
      FROM world_allocation_state allocation WHERE allocation.world_id = $1
    `, ['main', guest.player.id, ordinal])
    assert.deepEqual(afterReap.rows[0], {
      ...before.rows[0], plots: 0, released: 1
    }, 'guest cleanup does not serialize on or mutate the frontier cursor')

    const replacement = await service.ensureSession('', 'pglite-world-reuse')
    assert.deepEqual(
      [replacement.player.plotX, replacement.player.plotY],
      [coordinate.x, coordinate.y],
      'the next admission deterministically reuses the released coordinate'
    )
    const remaining = await database.query<{ count: number }>(String.raw`
      SELECT count(*)::integer AS count FROM world_released_slots
      WHERE world_id = $1 AND ordinal = $2
    `, ['main', ordinal])
    assert.equal(remaining.rows[0]?.count, 0)
  } finally {
    await service.close()
  }
})
