import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import type { QueryResult, QueryResultRow } from 'pg'
import { MIGRATIONS, migrate } from '../migrations'
import { PostgresPersistence } from './persistence'
import { PostgresUnitOfWork } from './repositories'
import type { SqlDatabase, SqlExecutor } from './database'
import { PersistenceGameService } from '../../runtime/service'
import { createPersistenceAttackService } from '../../runtime/attack-service'
import { outboxEvent } from '../repositories'
import { createApiMiddleware } from '../../node-adapter'
import { grantedSession } from '../../domain/auth'
import { allocationOrdinalOf, nextPlotVersion, persistentBotVillageIdAt } from '../../domain/world'
import type { AccountRecord, BotVillageRecord, VillageRecord } from '../model'
import { buildLegacyImportPlan, importLegacyPlan, verifyLegacyImport } from '../legacy-import'
import { LEGACY_COLLECTIONS, materializeLegacySnapshot } from '../legacy-snapshot'

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

test('PostgreSQL maintenance fence emits shared/update row locks and rejects ambiguous lock modes', async () => {
  const statements: string[] = []
  const sql: SqlExecutor = {
    async query<Row extends QueryResultRow = QueryResultRow>(statement: string): Promise<QueryResult<Row>> {
      statements.push(statement)
      return {
        command: 'SELECT',
        oid: 0,
        fields: [],
        rows: [{
          maintenance_enabled: false,
          maintenance_message: null,
          starter_village: null,
          updated_at: NOW,
          revision: 1
        }] as unknown as Row[],
        rowCount: 1
      }
    }
  }
  const unit = new PostgresUnitOfWork(sql)

  await unit.admin.getConfig({ forShare: true })
  await unit.admin.getConfig({ forUpdate: true })
  assert.match(statements[0]?.trim() ?? '', /FOR SHARE$/)
  assert.match(statements[1]?.trim() ?? '', /FOR UPDATE$/)
  await assert.rejects(
    unit.admin.getConfig({ forShare: true, forUpdate: true }),
    /lock mode is ambiguous/i
  )
  assert.equal(statements.length, 2, 'ambiguous lock options fail before issuing SQL')
})

function persistedBot(id = 'bot-pglite', x = 7, y = -5): BotVillageRecord {
  return {
    id,
    worldId: 'main',
    x,
    y,
    plotVersion: 1,
    worldGenerationVersion: 1,
    generatorVersion: 1,
    seed: 4_000_000_007,
    username: 'PGlite Iron Citadel',
    trophies: 3_100,
    profile: { difficulty: 'extreme', archetype: 'three-ward-citadel' },
    world: {
      id,
      ownerId: id,
      username: 'PGlite Iron Citadel',
      buildings: [
        { id: `${id}-hall`, type: 'town_hall', gridX: 11, gridY: 11, level: 4 },
        { id: `${id}-wall`, type: 'wall', gridX: 8, gridY: 11, level: 3 }
      ],
      obstacles: [],
      resources: { gold: 250_000, ore: 30_000, food: 40_000 },
      wallLevel: 3,
      lastSaveTime: NOW.getTime(),
      revision: 1
    },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW
  }
}

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

test('embedded PostgreSQL durably stores bot villages before map or attack consumers can read them', async () => {
  const database = new EmbeddedPostgres()
  try {
    await migrate(database)
    const persistence = new PostgresPersistence(database)
    const stored = persistedBot()
    await persistence.transaction(async tx => {
      assert.equal(await tx.world.insertBotVillage(stored), 'inserted')
      assert.equal(await tx.world.insertBotVillage({
        ...stored,
        createdAt: new Date(stored.createdAt.getTime() + 10),
        updatedAt: new Date(stored.updatedAt.getTime() + 10)
      }), 'existing')
      assert.deepEqual(await tx.world.getBotVillage(stored.id), stored)
      assert.deepEqual(await tx.world.getBotVillageAt('main', stored.x, stored.y), stored)
      assert.deepEqual(await tx.world.listBotVillages({
        worldId: 'main', minX: 0, maxX: 10, minY: -10, maxY: 0, now: NOW, limit: 5
      }), [stored])

      const batched = persistedBot('bot-pglite-batched', stored.x + 1, stored.y)
      await tx.world.provisionBotVillages([batched])
      await tx.world.provisionBotVillages([{
        ...batched,
        createdAt: new Date(NOW.getTime() + 10),
        updatedAt: new Date(NOW.getTime() + 10)
      }])
      assert.deepEqual(await tx.world.getBotVillage(batched.id), batched)
      const regenerated: BotVillageRecord = {
        ...batched,
        generatorVersion: 2,
        profile: { ...batched.profile, generatorVersion: 2 },
        world: { ...batched.world, revision: 2 },
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 1_000)
      }
      await tx.world.provisionBotVillages([regenerated])
      assert.deepEqual(await tx.world.getBotVillage(batched.id), regenerated)

      const advanced: BotVillageRecord = {
        ...stored,
        trophies: 3_250,
        world: { ...stored.world, revision: 2 },
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 1_000)
      }
      assert.equal(await tx.world.updateBotVillage(advanced, 1), true)
      assert.deepEqual(await tx.world.getBotVillage(stored.id), advanced)
    })

    const collision = persistedBot('bot-pglite-collision', stored.x, stored.y)
    await assert.rejects(
      persistence.transaction(tx => tx.world.insertBotVillage(collision)),
      /coordinate already exists/i
    )
    const rows = await database.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM bot_villages WHERE world_id = $1',
      ['main']
    )
    assert.equal(rows.rows[0]?.count, 2)

    await database.query(
      'INSERT INTO accounts(id, username_key, password_hash, registered, created_at) VALUES ($1, NULL, NULL, false, $2)',
      ['bot-plot-claimant', NOW]
    )
    await persistence.transaction(async tx => {
      await tx.world.ensureRegion({
        worldId: 'main', regionId: 'main:bot-claim-region', regionX: 0, regionY: -1,
        size: 32, generationVersion: 1, createdAt: NOW
      })
      await tx.world.assign({
        worldId: 'main', x: stored.x, y: stored.y, regionId: 'main:bot-claim-region',
        playerId: 'bot-plot-claimant', plotVersion: 2, assignedAt: NOW,
        leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
      })
      assert.deepEqual(await tx.world.getBotVillage(stored.id), {
        ...stored,
        trophies: 3_250,
        world: { ...stored.world, revision: 2 },
        revision: 2,
        updatedAt: new Date(NOW.getTime() + 1_000)
      }, 'a player claim hides but does not erase persisted bot authority')
      assert.equal((await tx.world.getOccupant('main', stored.x, stored.y))?.playerId, 'bot-plot-claimant')
      assert.equal(await tx.world.release('bot-plot-claimant'), true)
      assert.equal((await tx.world.getBotVillageAt('main', stored.x, stored.y))?.id, stored.id)
    })
  } finally {
    await database.close()
  }
})

test('embedded PostgreSQL admin authority matches memory semantics and audit rows are append-only', async () => {
  const database = new EmbeddedPostgres()
  try {
    await migrate(database)
    const persistence = new PostgresPersistence(database)
    const account: AccountRecord = {
      id: 'pg-admin-player',
      username: 'PgAdminChief',
      usernameKey: 'pgadminchief',
      passwordHash: 'scrypt:private-test-hash',
      registered: true,
      trophies: 20,
      shieldUntil: new Date(NOW.getTime() + 60_000),
      createdAt: new Date(NOW.getTime() - 60_000),
      lastSeenAt: NOW,
      revision: 1,
      revengeRights: {},
      botRaidCooldowns: {}
    }
    const village: VillageRecord = {
      playerId: account.id,
      buildings: [
        { id: 'pg-admin-hall', type: 'town_hall', gridX: 10, gridY: 10, level: 1 }
      ],
      obstacles: [],
      army: {},
      wallLevel: 1,
      gold: 10,
      ore: 20,
      food: 30,
      productionRemainders: { ore: 0, food: 0 },
      population: { count: 5, lastGrowthAt: NOW.getTime(), bornAt: [] },
      banner: null,
      simulatedThrough: NOW,
      lastMutationAt: NOW,
      layoutRevision: 1,
      appearanceRevision: 1,
      economyRevision: 1,
      simulationVersion: 1,
      nextEventAt: null
    }
    await persistence.transaction(async tx => {
      await tx.accounts.insert(account)
      await tx.villages.insert(village)
      await tx.sessions.insert({
        tokenHash: 'b'.repeat(64), playerId: account.id, createdAt: NOW, lastUsedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 60_000), deviceId: 'pg-admin-spec'
      })
      await tx.world.ensureRegion({
        worldId: 'main', regionId: 'main:pg-admin', regionX: 0, regionY: 0,
        size: 32, generationVersion: 1, createdAt: NOW
      })
      await tx.world.assign({
        worldId: 'main', x: 0, y: 0, regionId: 'main:pg-admin',
        playerId: account.id, plotVersion: 1, assignedAt: NOW,
        leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
      })
    })
    let now = new Date(NOW)
    const service = new PersistenceGameService(persistence, { now: () => new Date(now) })
    assert.equal((await service.adminPlayers('PgAdmin', 5))[0]?.id, account.id)
    const initialAdminConfig = await service.adminConfig()
    const postgresStarter = {
      resources: { gold: 310_000, ore: 320_000, food: 330_000 },
      buildings: [
        { type: 'town_hall', level: 1, gridX: 2, gridY: 2 },
        { type: 'army_camp', level: 2, gridX: 10, gridY: 10 }
      ],
      wallLevel: 1
    }
    await service.adminOperation({
      type: 'set_starter_village',
      starterVillage: postgresStarter,
      expectedRevision: initialAdminConfig.revision,
      reason: 'Persist PostgreSQL starter defaults'
    })
    const postgresCreated = await service.register(null, 'PgStarterChief', 'valid-password-123', 'pg-starter')
    assert.ok('token' in postgresCreated)
    if (!('token' in postgresCreated)) return
    assert.deepEqual(postgresCreated.world.resources, postgresStarter.resources)
    assert.deepEqual((await service.adminConfig()).starterVillage, postgresStarter,
      'the JSONB config round-trips through the production repository')
    const resourceAdjustment = await service.adminPlayerAction(account.id, {
      type: 'adjust_resources', gold: 90, ore: 100_001, food: 999_979, reason: 'postgres parity'
    })
    assert.equal(resourceAdjustment.changed, true)
    assert.equal(resourceAdjustment.affected, 3)
    now = new Date(NOW.getTime() + 60_000)
    const principal = { playerId: account.id }
    const loaded = await service.getWorld(principal)
    assert.deepEqual(
      { ore: loaded.resources.ore, food: loaded.resources.food },
      { ore: 100_021, food: 1_000_009 },
      'PostgreSQL materialization retains an admin restore above storage capacity'
    )
    const cappedIncome = await service.applyResources(principal, {
      resource: 'ore', delta: 25, reason: 'rock_haul', requestId: 'pg-admin-over-cap-income'
    }) as { ore: number }
    assert.equal(cappedIncome.ore, 100_021)
    const debited = await service.applyResources(principal, {
      resource: 'food', delta: -9, reason: 'support verification', requestId: 'pg-admin-over-cap-debit'
    }) as { food: number }
    assert.equal(debited.food, 1_000_000)
    const beforeSave = await service.getWorld(principal)
    const saved = await service.saveWorld(principal, {
      world: beforeSave, requestId: 'pg-admin-over-cap-save'
    })
    assert.deepEqual(
      { ore: saved.resources.ore, food: saved.resources.food },
      { ore: 100_021, food: 1_000_000 }
    )
    await service.adminOperation({
      type: 'set_test_mode', enabled: true, reason: 'PostgreSQL global test mode parity'
    })
    await service.adminPlayerAction(account.id, {
      type: 'set_test_mode', override: false, reason: 'PostgreSQL test mode override parity'
    })
    await service.adminPlayerAction(account.id, {
      type: 'set_access', state: 'banned', reason: 'postgres parity'
    })
    await service.adminOperation({
      type: 'set_maintenance', enabled: true, message: 'PG maintenance', reason: 'postgres parity'
    })

    const player = await service.adminPlayer(account.id)
    assert.deepEqual(player.resources, { gold: 100, ore: 100_021, food: 1_000_000 })
    assert.equal(player.access, 'banned')
    assert.deepEqual(player.testMode, { override: false, effective: false })
    assert.equal(player.activeSessions, 0)
    const adminConfig = await service.adminConfig()
    assert.equal(adminConfig.maintenance.enabled, true)
    assert.deepEqual(adminConfig.testMode, { enabled: true, overrideCount: 1 })
    assert.equal((await service.adminAudit(10)).length, 6)
    assert.equal(JSON.stringify(player).includes('private-test-hash'), false)

    const resourceLedger = await database.query<{
      currency: string
      delta: string | number
      balance_after: string | number
    }>(String.raw`
      SELECT currency, delta, balance_after
      FROM balance_ledger
      WHERE player_id = $1 AND operation = 'admin.adjust_resources'
      ORDER BY currency
    `, [account.id])
    assert.deepEqual(resourceLedger.rows.map(row => ({
      currency: row.currency,
      delta: Number(row.delta),
      balanceAfter: Number(row.balance_after)
    })), [
      { currency: 'food', delta: 999_979, balanceAfter: 1_000_009 },
      { currency: 'gold', delta: 90, balanceAfter: 100 },
      { currency: 'ore', delta: 100_001, balanceAfter: 100_021 }
    ])

    await assert.rejects(
      database.query('DELETE FROM admin_audit_log WHERE target_id = $1', [account.id]),
      /append-only/i
    )
    assert.equal((await service.adminAudit(10)).length, 6)
  } finally {
    await database.close()
  }
})

test('embedded PostgreSQL base reset preserves account/session/plot authority and purges imported base payloads', async () => {
  const database = new EmbeddedPostgres()
  try {
    await migrate(database)
    const persistence = new PostgresPersistence(database)
    const service = new PersistenceGameService(persistence, {
      now: () => new Date(NOW),
      starterShieldMs: 7_200_000
    })
    const session = await service.register(null, 'PgResetChief', 'valid-password-123', 'pg-reset')
    assert.ok('token' in session)
    if (!('token' in session)) return

    const initialPlot = await persistence.transaction(tx => tx.world.getPlayerPlot(session.player.id))
    assert.ok(initialPlot)
    if (!initialPlot) return
    await database.query(String.raw`
      UPDATE villages SET
        buildings = buildings || $2::jsonb,
        layout_revision = layout_revision + 1,
        last_mutation_at = $3
      WHERE player_id = $1
    `, [
      session.player.id,
      [{ id: 'pg-reset-watchtower', type: 'watchtower', gridX: 3, gridY: 3, level: 1 }],
      NOW
    ])
    const advertised = await service.map(
      { playerId: session.player.id },
      initialPlot.x,
      initialPlot.y,
      1
    )
    const advertisedBot = advertised.plots.find(plot => plot.kind === 'bot' && plot.world)
    assert.ok(advertisedBot, 'the PostgreSQL map fixture must persist and advertise a nearby bot')
    if (!advertisedBot) return
    const retiredBotRevision = 41
    await database.query(String.raw`
      UPDATE bot_villages SET
        revision = $2,
        world = jsonb_set(world, '{revision}', to_jsonb($2::bigint), true),
        updated_at = $3
      WHERE id = $1
    `, [advertisedBot.ownerId, retiredBotRevision, NOW])
    const retiredKnown = `${advertisedBot.x},${advertisedBot.y}:${advertisedBot.ownerId}:${retiredBotRevision}`

    const before = await persistence.transaction(async tx => ({
      account: await tx.accounts.getById(session.player.id),
      village: await tx.villages.get(session.player.id),
      plot: await tx.world.getPlayerPlot(session.player.id)
    }))
    await service.adminPlayerAction(session.player.id, {
      type: 'adjust_resources', gold: 999, reason: 'Seed postgres reset history'
    })
    await database.query(String.raw`
      INSERT INTO legacy_import_manifest(collection, record_key, sha256, payload, imported_at)
      VALUES ('players', 'old-player', $1, $2::jsonb, $3)
    `, ['c'.repeat(64), { buildings: [{ id: 'old-secret-base' }] }, NOW])
    await service.adminOperation({
      type: 'set_maintenance', enabled: true, message: 'Reset in progress', reason: 'Prepare postgres base reset'
    })

    // Isolate a missing profile while the registered account's village and
    // plot remain complete. The replacement INSERT is sourced from profiles,
    // so accepting this shape would silently preserve identity without a base.
    await database.query('DELETE FROM player_profiles WHERE player_id = $1', [session.player.id])
    await assert.rejects(service.adminOperation({
      type: 'reset_all_bases',
      confirmation: 'RESET ALL BASES',
      reason: 'Reject missing postgres profile authority'
    }), (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'ADMIN_RESET_INTEGRITY_FAILED')
    assert.ok(before.account)
    if (!before.account) return
    await database.query(String.raw`
      INSERT INTO player_profiles(
        player_id, username, trophies, shield_until, last_seen_at, revision,
        revenge_rights, bot_raid_cooldowns
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
    `, [
      before.account.id,
      before.account.username,
      before.account.trophies,
      before.account.shieldUntil,
      before.account.lastSeenAt,
      before.account.revision,
      before.account.revengeRights,
      before.account.botRaidCooldowns
    ])

    // Guests are preserved/reset too, so an incomplete guest root must not be
    // omitted from the integrity check or counted as a successfully reset base.
    await database.query(String.raw`
      INSERT INTO accounts(id, username_key, password_hash, registered, created_at)
      VALUES ('pg-orphan-guest', NULL, NULL, false, $1)
    `, [NOW])
    await assert.rejects(service.adminOperation({
      type: 'reset_all_bases',
      confirmation: 'RESET ALL BASES',
      reason: 'Reject incomplete postgres guest authority'
    }), (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'ADMIN_RESET_INTEGRITY_FAILED')
    await database.query("DELETE FROM accounts WHERE id = 'pg-orphan-guest'")

    // A future/corrupt realm can satisfy bot_villages' realm FK without
    // owning world_allocation_state, leaving nowhere durable to advance its
    // replacement cache epoch. Reset must fail closed before deleting it.
    const orphanWorldId = 'pg-orphan-bot-realm'
    const orphanBotId = persistentBotVillageIdAt(orphanWorldId, 8, 8)
    const orphanBot: BotVillageRecord = {
      ...persistedBot(orphanBotId, 8, 8),
      worldId: orphanWorldId
    }
    await database.query(String.raw`
      INSERT INTO world_realms(id, generator_version, created_at)
      VALUES ($1, 1, $2)
    `, [orphanWorldId, NOW])
    await persistence.transaction(tx => tx.world.insertBotVillage(orphanBot))
    await assert.rejects(service.adminOperation({
      type: 'reset_all_bases',
      confirmation: 'RESET ALL BASES',
      reason: 'Reject missing postgres bot epoch authority'
    }), (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'ADMIN_RESET_INTEGRITY_FAILED')
    assert.ok(await persistence.transaction(tx => tx.world.getBotVillage(orphanBotId)),
      'failed bot-epoch preflight must leave the persisted bot intact')
    await persistence.transaction(tx => tx.world.deleteBotVillage(orphanBotId))
    await database.query('DELETE FROM world_realms WHERE id = $1', [orphanWorldId])

    const reset = await service.adminOperation({
      type: 'reset_all_bases',
      confirmation: 'RESET ALL BASES',
      reason: 'Scheduled postgres authority reset'
    })
    assert.equal(reset.resetSummary?.accountsPreserved, 1)
    assert.equal(reset.resetSummary?.sessionsPreserved, 1)
    assert.equal(reset.resetSummary?.playerPlotsPreserved, 1)
    assert.equal(reset.resetSummary?.playerVillagesReset, 1)
    assert.ok((reset.resetSummary?.auxiliaryRecordsPurged ?? 0) >= 2)

    const after = await persistence.transaction(async tx => ({
      account: await tx.accounts.getById(session.player.id),
      village: await tx.villages.get(session.player.id),
      plot: await tx.world.getPlayerPlot(session.player.id),
      sessions: await tx.sessions.listForPlayer(session.player.id, 10)
    }))
    assert.equal(after.account?.username, 'PgResetChief')
    assert.equal(after.account?.passwordHash, before.account?.passwordHash)
    assert.equal(after.account?.trophies, 0)
    assert.equal(after.account?.shieldUntil?.getTime(), NOW.getTime() + 7_200_000)
    assert.deepEqual(after.plot, before.plot)
    assert.equal(after.sessions.length, 1)
    assert.equal(after.village?.banner, null)
    assert.ok((after.village?.layoutRevision ?? 0) > (before.village?.layoutRevision ?? 0))
    const beforeIds = new Set(before.village?.buildings.map(building => (
      typeof building === 'object' && building !== null && !Array.isArray(building) ? String(building.id) : ''
    )))
    const afterIds = after.village?.buildings.map(building => (
      typeof building === 'object' && building !== null && !Array.isArray(building) ? String(building.id) : ''
    )) ?? []
    assert.equal(new Set(afterIds).size, afterIds.length)
    assert.equal(afterIds.some(id => beforeIds.has(id)), false)

    const purged = await database.query<{
      attacks: string | number
      bots: string | number
      notifications: string | number
      ledger: string | number
      manifests: string | number
    }>(String.raw`
      SELECT
        (SELECT COUNT(*) FROM attacks) AS attacks,
        (SELECT COUNT(*) FROM bot_villages) AS bots,
        (SELECT COUNT(*) FROM notifications) AS notifications,
        (SELECT COUNT(*) FROM balance_ledger) AS ledger,
        (SELECT COUNT(*) FROM legacy_import_manifest) AS manifests
    `)
    assert.deepEqual(purged.rows[0] && {
      attacks: Number(purged.rows[0].attacks),
      bots: Number(purged.rows[0].bots),
      notifications: Number(purged.rows[0].notifications),
      ledger: Number(purged.rows[0].ledger),
      manifests: Number(purged.rows[0].manifests)
    }, { attacks: 0, bots: 0, notifications: 0, ledger: 0, manifests: 0 })
    assert.equal((await service.adminConfig()).maintenance.enabled, true)
    assert.ok((await service.adminAudit(10)).some(entry => entry.action === 'reset_all_bases'))

    const allocation = await persistence.transaction(tx => tx.world.getAllocation(initialPlot.worldId))
    assert.ok((allocation?.botRevisionEpoch ?? 0) > retiredBotRevision,
      'the production reset must durably cross every purged bot revision')
    await database.query(String.raw`
      UPDATE villages SET
        buildings = buildings || $2::jsonb,
        layout_revision = layout_revision + 1,
        last_mutation_at = $3
      WHERE player_id = $1
    `, [
      session.player.id,
      [{ id: 'pg-reset-watchtower-after', type: 'watchtower', gridX: 3, gridY: 3, level: 1 }],
      NOW
    ])
    await service.adminOperation({
      type: 'set_maintenance', enabled: false, reason: 'Verify postgres bot cache epoch'
    })
    const refreshed = await service.map(
      { playerId: session.player.id },
      initialPlot.x,
      initialPlot.y,
      1,
      retiredKnown
    )
    const replacement = refreshed.plots.find(plot => (
      plot.x === advertisedBot.x && plot.y === advertisedBot.y && plot.kind === 'bot'
    ))
    assert.ok(replacement?.world, 'a stale pre-reset known token must receive the replacement bot world')
    assert.equal(replacement?.ownerId, advertisedBot.ownerId, 'coordinate-derived bot identity remains stable')
    assert.ok(Number(replacement?.revision ?? 0) > retiredBotRevision)
  } finally {
    await database.close()
  }
})

test('legacy cutover preserves every persisted bot field and depleted resource', async () => {
  const database = new EmbeddedPostgres()
  const parent = mkdtempSync(path.join(tmpdir(), 'clash-bot-cutover-'))
  const sourceRoot = path.join(parent, 'source')
  const frozenRoot = path.join(parent, 'frozen')
  mkdirSync(sourceRoot)
  for (const collection of LEGACY_COLLECTIONS) {
    mkdirSync(path.join(sourceRoot, collection), { recursive: true })
  }
  const x = 1
  const y = 0
  const id = persistentBotVillageIdAt('main', x, y)
  const createdAt = NOW.getTime() - 20_000
  const updatedAt = NOW.getTime() - 1_000
  const record = persistedBot(id, x, y)
  record.revision = 7
  record.updatedAt = new Date(updatedAt)
  record.createdAt = new Date(createdAt)
  record.world.revision = 7
  record.world.lastSaveTime = updatedAt
  record.world.resources = { gold: 12_345, ore: 2_222, food: 3_333 }
  writeFileSync(path.join(sourceRoot, 'bot-villages', `${id}.json`), JSON.stringify({
    ...record,
    presentationSeedVersion: 0,
    createdAt,
    updatedAt
  }))
  writeFileSync(path.join(sourceRoot, 'players', 'cutover-player.json'), JSON.stringify({
    id: 'cutover-player',
    tokenHashes: ['b'.repeat(64)],
    username: 'Camp Settler',
    createdAt,
    lastSeen: updatedAt,
    trophies: 17,
    balance: 1_000,
    lastAccrualAt: updatedAt,
    lastMutationAt: updatedAt,
    revision: 2,
    buildings: [{ id: 'cutover-hall', type: 'town_hall', gridX: 11, gridY: 11, level: 1 }],
    obstacles: [],
    army: {},
    wallLevel: 1,
    requestKeys: [],
    population: { count: 1, lastGrowthAt: updatedAt },
    ore: 25,
    food: 50,
    plotX: x,
    plotY: y,
    plotVersion: 3,
    productionRemainders: { ore: 0, food: 0 }
  }))
  writeFileSync(path.join(sourceRoot, 'world-state', 'main.json'), JSON.stringify({
    allocation: {
      schemaVersion: 1,
      worldId: 'main',
      regionSize: 32,
      currentGenerationVersion: 1,
      nextOrdinal: 8
    },
    releasedSlots: [],
    presentationSeedVersion: 0
  }))

  try {
    materializeLegacySnapshot({ dataRoot: sourceRoot, outputRoot: frozenRoot, cutoffAt: NOW })
    const plan = buildLegacyImportPlan(frozenRoot, NOW)
    assert.deepEqual(plan.issues, [])
    assert.equal(plan.counts['bot-villages'], 1)
    await migrate(database)
    await importLegacyPlan(database, plan)

    const persistence = new PostgresPersistence(database)
    const imported = await persistence.transaction(tx => tx.world.getBotVillage(id))
    assert.deepEqual(imported, record)
    await persistence.transaction(async tx => {
      assert.equal((await tx.world.getOccupant('main', x, y))?.playerId, 'cutover-player')
      assert.equal((await tx.world.getBotVillageAt('main', x, y))?.id, id)
    })
    assert.deepEqual(await verifyLegacyImport(database, plan), {
      ok: true,
      issues: [],
      sourceRecords: 3,
      importedRecords: 3
    })
  } finally {
    await database.close()
    rmSync(parent, { recursive: true, force: true })
  }
})

test('embedded PostgreSQL semantics cover migration, world, attack, replay, and retention paths', async () => {
  const database = new EmbeddedPostgres()
  await migrate(database)
  const persistence = new PostgresPersistence(database)
  const attacks = createPersistenceAttackService(persistence, { now: () => new Date(NOW) })
  const service = new PersistenceGameService(persistence, {
    attacks,
    starterShieldMs: 0,
    allowDebugGrants: true,
    allowGuestSessions: true,
    now: () => new Date(NOW)
  })

  try {
    const first = grantedSession(await service.ensureSession('', 'pglite-a'))
    const second = grantedSession(await service.ensureSession('', 'pglite-b'))
    const third = grantedSession(await service.ensureSession('', 'pglite-c'))
    const attacker = { playerId: first.player.id }

    const bannerBefore = await database.query<{
      banner: { palette: number; emblem: number; pattern: number } | null
      appearance_revision: string | number
      economy_revision: string | number
    }>('SELECT banner, appearance_revision, economy_revision FROM villages WHERE player_id = $1', [attacker.playerId])
    const chosenBanner = { palette: 5, emblem: 2, pattern: 4 }
    assert.deepEqual(await service.setBanner(attacker, chosenBanner), { banner: chosenBanner })
    const bannerAfter = await database.query<{
      banner: { palette: number; emblem: number; pattern: number } | null
      appearance_revision: string | number
      economy_revision: string | number
    }>('SELECT banner, appearance_revision, economy_revision FROM villages WHERE player_id = $1', [attacker.playerId])
    assert.deepEqual(bannerAfter.rows[0]?.banner, chosenBanner)
    assert.equal(
      Number(bannerAfter.rows[0]?.appearance_revision),
      Number(bannerBefore.rows[0]?.appearance_revision) + 1
    )
    assert.equal(
      Number(bannerAfter.rows[0]?.economy_revision),
      Number(bannerBefore.rows[0]?.economy_revision),
      'the PostgreSQL appearance CAS leaves the economy revision untouched'
    )
    assert.deepEqual((await service.getWorld(attacker)).banner, chosenBanner)
    const bannerMap = await service.map(attacker, first.player.plotX, first.player.plotY, 0) as {
      plots: Array<{ ownerId?: string; world?: { banner?: typeof chosenBanner } }>
    }
    assert.deepEqual(
      bannerMap.plots.find(plot => plot.ownerId === attacker.playerId)?.world?.banner,
      chosenBanner
    )
    const bannerAtlas = await service.atlas(attacker) as {
      players: Array<{ me?: boolean; banner?: typeof chosenBanner | null }>
    }
    assert.deepEqual(bannerAtlas.players.find(player => player.me)?.banner, chosenBanner)

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
    assert.equal(migrationCount.rows[0]?.count, MIGRATIONS.length)
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
      allowGuestSessions: true,
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

    await requestJson(origin, '/player/banner', {
      method: 'POST', token: attacker.token,
      body: { banner: { palette: 2, emblem: 1, pattern: 3 } }
    })
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
    const batched = await requestJson<{
      army: { warrior: number }
      revision: number
      world: { army: { warrior: number }; revision: number }
    }>(origin, '/army/batch', {
      method: 'POST', token: attacker.token,
      body: {
        operations: [
          { kind: 'train', type: 'warrior', count: 1 },
          { kind: 'untrain', type: 'warrior', count: 1 }
        ],
        requestId: 'http-pglite-army-batch'
      }
    })
    assert.equal(batched.army.warrior, 2)
    assert.equal(batched.world.army.warrior, 2)
    assert.equal(batched.world.revision, batched.revision)

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
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    allowGuestSessions: true
  })

  try {
    const guest = grantedSession(await service.ensureSession('', 'pglite-world-fence'))
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
    // This direct service call intentionally bypasses HTTP authentication to
    // inspect map classification at the lease boundary. Pin simulation first
    // so the probe itself does not create an economy-ledger reference that
    // would (correctly) keep the guest account archived separately.
    await database.query(
      'UPDATE villages SET simulated_through = $2 WHERE player_id = $1',
      [guest.player.id, now]
    )
    const expiredMap = await service.map(
      { playerId: guest.player.id }, coordinate.x, coordinate.y, 0
    ) as { plots: Array<Record<string, unknown>> }
    assert.deepEqual(expiredMap.plots, [{
      x: coordinate.x,
      y: coordinate.y,
      kind: 'empty',
      settleable: false
    }], 'PostgreSQL map hides an expired claim until the reaper releases it')
    const botBeforeReap = await database.query<{ count: number }>(String.raw`
      SELECT count(*)::integer AS count FROM bot_villages
      WHERE world_id = $1 AND x = $2 AND y = $3
    `, ['main', coordinate.x, coordinate.y])
    assert.equal(botBeforeReap.rows[0]?.count, 0, 'map never provisions through an unreaped claim')
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

    const replacement = grantedSession(await service.ensureSession('', 'pglite-world-reuse'))
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
