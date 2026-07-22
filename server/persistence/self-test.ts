import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  applyAttackCommand,
  engageAttack,
  prepareAttack
} from '../attack-domain/domain'
import { combatSnapshotHash } from '../attack-domain/simulation'
import type { AttackAggregate, CombatVillageSnapshot } from '../attack-domain/types'
import { allocationOrdinalOf } from '../domain/world/allocation'
import {
  attackCommandsFromAuthority,
  attackRecordFromAuthority,
  attackRecordWithAuthority
} from './attack-authority'
import { buildLegacyImportPlan, mapLegacyReplayAttack } from './legacy-import'
import { MemoryPersistence } from './memory'
import { MIGRATIONS } from './migrations'
import type { AccountRecord, AttackRecord, BotVillageRecord, JsonObject, VillageRecord } from './model'
import type { SqlExecutor } from './postgres/database'
import { PostgresUnitOfWork } from './postgres/repositories'
import { idempotentMutation, outboxEvent } from './repositories'
import './legacy-snapshot.spec'

const NOW = new Date('2026-07-11T12:00:00.000Z')

function account(id: string, patch: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id,
    username: id,
    usernameKey: null,
    passwordHash: null,
    registered: false,
    trophies: 0,
    shieldUntil: null,
    createdAt: NOW,
    lastSeenAt: NOW,
    revision: 0,
    revengeRights: {},
    botRaidCooldowns: {},
    ...patch
  }
}

function village(playerId: string, appearanceRevision = 1): VillageRecord {
  return {
    playerId,
    buildings: [{ id: `townhall-${playerId}`, type: 'townhall', x: 0, y: 0 }],
    obstacles: [],
    army: {},
    wallLevel: 1,
    gold: 100,
    ore: 25,
    food: 50,
    productionRemainders: { ore: 0, food: 0 },
    population: { count: 3 },
    banner: null,
    simulatedThrough: NOW,
    lastMutationAt: NOW,
    layoutRevision: appearanceRevision,
    appearanceRevision,
    economyRevision: 0,
    simulationVersion: 2,
    nextEventAt: null
  }
}

function botVillage(id = 'bot-persisted', x = 4, y = -3): BotVillageRecord {
  return {
    id,
    worldId: 'main',
    x,
    y,
    plotVersion: 1,
    worldGenerationVersion: 1,
    generatorVersion: 1,
    seed: 4_294_967_291,
    username: 'Citadel of Ash',
    trophies: 2_400,
    profile: { difficulty: 'advanced', archetype: 'segmented-citadel' },
    world: {
      id,
      ownerId: id,
      username: 'Citadel of Ash',
      buildings: [
        { id: `${id}-hall`, type: 'town_hall', gridX: 11, gridY: 11, level: 4 },
        { id: `${id}-wall`, type: 'wall', gridX: 9, gridY: 11, level: 3 }
      ],
      obstacles: [],
      resources: { gold: 180_000, ore: 20_000, food: 35_000 },
      wallLevel: 3,
      lastSaveTime: NOW.getTime(),
      revision: 1
    },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function playerAttack(id: string, attackerId: string, defenderId: string): AttackRecord {
  return {
    id,
    attackerId,
    defenderId,
    targetKind: 'player',
    targetId: defenderId,
    worldId: 'main',
    targetX: 1,
    targetY: 1,
    targetPlotVersion: 1,
    state: 'preparing',
    stateVersion: 0,
    simulationVersion: 1,
    seed: id,
    fencingTokenHash: id,
    defenderSnapshot: {},
    reservedArmy: {},
    createdAt: NOW,
    engagedAt: null,
    updatedAt: NOW,
    deadlineAt: new Date(NOW.getTime() + 60_000),
    endedAt: null,
    result: null,
    authority: null
  }
}

function preparedAuthority(
  id = 'authority-attack',
  attackerId = 'authority-attacker',
  defenderId = 'authority-defender',
  targetX = 1,
  targetY = 1
): { record: AttackRecord; authority: AttackAggregate } {
  const snapshot: CombatVillageSnapshot = {
    schemaVersion: 1,
    snapshotId: `snapshot-${id}`,
    villageVersion: 'appearance_1',
    buildings: [{ id: 'town-hall', type: 'town_hall', level: 1, gridX: 10, gridY: 10 }]
  }
  const authority = prepareAttack({
    attackId: id,
    attackerId,
    attackerName: 'Authority Attacker',
    selectionSource: 'NEIGHBOR',
    target: {
      kind: 'PLAYER',
      targetId: defenderId,
      playerId: defenderId,
      shieldBypass: 'NONE',
      plot: { worldId: 'main', x: targetX, y: targetY, version: '1' },
      villageVersion: snapshot.villageVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: combatSnapshotHash(snapshot)
    },
    snapshot,
    simulationSeed: `seed-${id}`,
    rewardPolicy: {
      lootCaps: { gold: 100, ore: 10, food: 5 },
      winTrophyBase: 10,
      winTrophyPerFivePercent: 1,
      lossTrophyDelta: -5
    },
    requestedArmy: { warrior: 1 },
    troopLevel: 1,
    now: NOW.getTime()
  }, {
    reserveArmy: request => ({
      reservationId: `reservation-${id}`,
      sourceArmyVersion: 2,
      reserved: request.requested,
      troopLevel: request.troopLevel
    })
  })
  return {
    authority,
    record: attackRecordFromAuthority(authority, { fencingTokenHash: id, updatedAt: NOW })
  }
}

function preparedBotAuthority(id = 'bot-attack', attackerId = 'attacker') {
  const snapshot: CombatVillageSnapshot = {
    schemaVersion: 1,
    snapshotId: `snapshot-${id}`,
    villageVersion: 'bot_7_v1',
    buildings: [{ id: 'bot-town-hall', type: 'town_hall', level: 1, gridX: 10, gridY: 10 }]
  }
  const botId = 'bot_3_4_7'
  const authority = prepareAttack({
    attackId: id,
    attackerId,
    attackerName: 'Bot Attacker',
    selectionSource: 'BOT_MAP',
    target: {
      kind: 'BOT',
      targetId: botId,
      botId,
      seed: 7,
      plot: { worldId: 'main', x: 3, y: 4, version: 'generation_1_7' },
      villageVersion: snapshot.villageVersion,
      snapshotId: snapshot.snapshotId,
      snapshotHash: combatSnapshotHash(snapshot)
    },
    snapshot,
    simulationSeed: 'bot-seed-7',
    rewardPolicy: {
      lootCaps: { gold: 100, ore: 0, food: 0 },
      winTrophyBase: 0,
      winTrophyPerFivePercent: 0,
      lossTrophyDelta: 0
    },
    requestedArmy: { warrior: 1 },
    troopLevel: 1,
    now: NOW.getTime()
  }, {
    reserveArmy: request => ({
      reservationId: `reservation-${id}`,
      sourceArmyVersion: 1,
      reserved: request.requested,
      troopLevel: request.troopLevel
    })
  })
  return {
    authority,
    record: attackRecordFromAuthority(authority, {
      fencingTokenHash: id,
      targetPlotVersion: 1,
      updatedAt: NOW
    })
  }
}

function engagedAuthority(authority: AttackAggregate): AttackAggregate {
  const now = NOW.getTime() + 1_000
  return engageAttack(authority, {
    expectedPhase: authority.phase,
    expectedVersion: authority.version
  }, now, {
    validateAndLockTarget: request => ({
      available: true,
      targetId: request.target.targetId,
      plot: request.target.plot,
      villageVersion: request.target.villageVersion,
      shieldUntil: 0,
      observedAt: now,
      engagementLease: {
        leaseId: `lease-${authority.attackId}`,
        acquiredAt: now,
        expiresAt: now + 120_000
      }
    })
  })
}

test('transaction rollback leaves no partial state', async () => {
  const persistence = new MemoryPersistence()
  await assert.rejects(persistence.transaction(async tx => {
    await tx.accounts.insert(account('rollback'))
    throw new Error('fail')
  }))
  await persistence.transaction(async tx => {
    assert.equal(await tx.accounts.getById('rollback'), null)
  })
})

test('appearance revision is canonical village state with an additive migration', async () => {
  const migration = MIGRATIONS.find(item => item.name === 'village_appearance_revision')
  assert.equal(migration?.version, 4)
  assert.match(migration?.sql ?? '', /appearance_revision/)
  const bannerMigration = MIGRATIONS.find(item => item.name === 'village_banner')
  assert.equal(bannerMigration?.version, 12)
  assert.match(bannerMigration?.sql ?? '', /ADD COLUMN banner jsonb/)

  const persistence = new MemoryPersistence()
  const record = village('visible-player', 11)
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('visible-player'))
    await tx.villages.insert(record)
    assert.equal((await tx.villages.get('visible-player'))?.appearanceRevision, 11)
    const changedAt = new Date(NOW.getTime() + 1_000)
    const changed = {
      ...record,
      banner: { palette: 2, emblem: 4, pattern: 1 },
      lastMutationAt: changedAt,
      appearanceRevision: 12
    }
    assert.equal(await tx.villages.updateAppearance(changed, 11), true)
    assert.equal(await tx.villages.updateAppearance({ ...changed, appearanceRevision: 13 }, 11), false)
    assert.deepEqual(await tx.villages.get('visible-player'), changed)
  })

  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const sql = {
    query: async (query: string, values?: readonly unknown[]) => {
      calls.push({ sql: query, values })
      if (/^\s*SELECT/.test(query)) {
        return { rows: [{
          player_id: record.playerId,
          buildings: record.buildings,
          obstacles: record.obstacles,
          army: record.army,
          wall_level: record.wallLevel,
          gold: String(record.gold),
          ore: String(record.ore),
          food: String(record.food),
          production_remainders: record.productionRemainders,
          population: record.population,
          banner: record.banner,
          simulated_through: record.simulatedThrough,
          last_mutation_at: record.lastMutationAt,
          layout_revision: String(record.layoutRevision),
          appearance_revision: String(record.appearanceRevision),
          economy_revision: String(record.economyRevision),
          simulation_version: record.simulationVersion,
          next_event_at: record.nextEventAt
        }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
  } as unknown as SqlExecutor
  const postgres = new PostgresUnitOfWork(sql)
  await postgres.villages.insert(record)
  const insert = calls[0]!
  assert.match(insert.sql, /appearance_revision/)
  assert.equal(insert.values?.[10], null)
  assert.equal(insert.values?.[14], 11)
  assert.equal((await postgres.villages.get(record.playerId))?.appearanceRevision, 11)
  const changedAt = new Date(NOW.getTime() + 1_000)
  const changed = {
    ...record,
    banner: { palette: 2, emblem: 4, pattern: 1 },
    lastMutationAt: changedAt,
    appearanceRevision: 12
  }
  assert.equal(await postgres.villages.updateAppearance(changed, 11), true)
  const appearanceUpdate = calls.at(-1)!
  assert.match(appearanceUpdate.sql, /UPDATE villages SET[\s\S]*banner = \$2::jsonb/)
  assert.deepEqual(appearanceUpdate.values, [
    record.playerId, changed.banner, changedAt, 12, 11
  ])
})

test('persistent bot villages are idempotent, bounded, CAS-safe, and survive player claims', async () => {
  const migration = MIGRATIONS.find(item => item.name === 'persistent_bot_villages')
  assert.equal(migration?.version, 13)
  assert.match(migration?.sql ?? '', /CREATE TABLE bot_villages/)
  assert.match(migration?.sql ?? '', /UNIQUE\(world_id, x, y\)/)
  const epochMigration = MIGRATIONS.find(item => item.name === 'bot_revision_epoch')
  assert.equal(epochMigration?.version, 15)
  assert.match(epochMigration?.sql ?? '', /bot_revision_epoch bigint NOT NULL DEFAULT 1/)
  const starterMigration = MIGRATIONS.find(item => item.name === 'admin_starter_village')
  assert.equal(starterMigration?.version, 16)
  assert.match(starterMigration?.sql ?? '', /ADD COLUMN starter_village jsonb/)

  const persistence = new MemoryPersistence()
  const stored = botVillage()
  await persistence.transaction(async tx => {
    assert.equal(await tx.world.insertBotVillage(stored), 'inserted')
    assert.equal(await tx.world.insertBotVillage({
      ...stored,
      createdAt: new Date(stored.createdAt.getTime() + 5),
      updatedAt: new Date(stored.updatedAt.getTime() + 5)
    }), 'existing', 'a concurrent provisioner adopts the committed timestamps')
    assert.deepEqual(await tx.world.getBotVillage(stored.id), stored)
    assert.deepEqual(await tx.world.getBotVillageAt(stored.worldId, stored.x, stored.y), stored)
    assert.deepEqual(await tx.world.listBotVillages({
      worldId: 'main', minX: 0, maxX: 5, minY: -5, maxY: 0, now: NOW, limit: 10
    }), [stored])

    const batched = botVillage('bot-batched', 5, -3)
    await tx.world.provisionBotVillages([batched])
    await tx.world.provisionBotVillages([{
      ...batched,
      createdAt: new Date(NOW.getTime() + 5),
      updatedAt: new Date(NOW.getTime() + 5)
    }])
    assert.deepEqual(await tx.world.getBotVillage(batched.id), batched,
      'same-generator batch retries adopt committed timestamps')
    const regenerated: BotVillageRecord = {
      ...batched,
      generatorVersion: 2,
      profile: { ...batched.profile, generatorVersion: 2 },
      world: { ...batched.world, revision: 2 },
      revision: 2,
      updatedAt: new Date(NOW.getTime() + 1_000)
    }
    await tx.world.provisionBotVillages([regenerated])
    assert.deepEqual(await tx.world.getBotVillage(batched.id), regenerated,
      'one bounded batch advances same-provenance generator authority')
    await assert.rejects(tx.world.insertBotVillage({
      ...stored,
      id: 'bot-coordinate-collision',
      world: { ...stored.world, id: 'bot-coordinate-collision', ownerId: 'bot-coordinate-collision' }
    }), /coordinate already exists/i)

    const advanced: BotVillageRecord = {
      ...stored,
      username: 'Citadel of Embers',
      trophies: 2_550,
      world: { ...stored.world, username: 'Citadel of Embers', revision: 2 },
      revision: 2,
      updatedAt: new Date(NOW.getTime() + 1_000)
    }
    assert.equal(await tx.world.updateBotVillage(advanced, 1), true)
    assert.equal(await tx.world.updateBotVillage({ ...advanced, revision: 3 }, 1), false)
    assert.deepEqual(await tx.world.getBotVillage(stored.id), advanced)

    await tx.accounts.insert(account('bot-replacing-player'))
    await tx.villages.insert(village('bot-replacing-player'))
    await tx.world.ensureRegion({
      worldId: 'main', regionId: 'main:1:-1:v1', regionX: 0, regionY: -1,
      size: 32, generationVersion: 1, createdAt: NOW
    })
    await tx.world.assign({
      worldId: 'main', x: stored.x, y: stored.y, regionId: 'main:1:-1:v1',
      playerId: 'bot-replacing-player', plotVersion: 2, assignedAt: NOW,
      leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
    })
    assert.deepEqual(await tx.world.getBotVillage(stored.id), advanced,
      'a real-player claim hides but never destroys durable bot authority')
    assert.equal((await tx.world.getOccupant('main', stored.x, stored.y))?.playerId, 'bot-replacing-player')
    assert.equal(await tx.world.release('bot-replacing-player'), true)
    assert.deepEqual(await tx.world.getBotVillageAt('main', stored.x, stored.y), advanced,
      'the same bot identity resurfaces after the player leaves')
  })
  await persistence.close()
})

test('PostgreSQL persists and reloads command + aggregate authority atomically', async () => {
  const prepared = preparedAuthority('postgres-authority')
  const engaged = engagedAuthority(prepared.authority)
  const surrendered = applyAttackCommand(engaged, {
    expectedPhase: engaged.phase,
    expectedVersion: engaged.version
  }, { type: 'SURRENDER', commandId: 'postgres-surrender', sequence: 1 }, NOW.getTime() + 2_000).attack
  const command = attackCommandsFromAuthority(surrendered)[0]!
  let current = prepared.record
  let storedCommand: typeof command | undefined
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []

  const row = (record: AttackRecord) => ({
    id: record.id,
    attacker_id: record.attackerId,
    defender_id: record.defenderId,
    target_kind: record.targetKind,
    target_id: record.targetId,
    world_id: record.worldId,
    target_x: record.targetX,
    target_y: record.targetY,
    target_plot_version: String(record.targetPlotVersion),
    state: record.state,
    state_version: String(record.stateVersion),
    simulation_version: record.simulationVersion,
    seed: record.seed,
    fencing_token_hash: record.fencingTokenHash,
    defender_snapshot: record.defenderSnapshot,
    reserved_army: record.reservedArmy,
    created_at: record.createdAt,
    engaged_at: record.engagedAt,
    updated_at: record.updatedAt,
    deadline_at: record.deadlineAt,
    ended_at: record.endedAt,
    result: record.result,
    authority: record.authority
  })
  const commandRow = (record: typeof command) => ({
    attack_id: record.attackId,
    sequence: record.sequence,
    actor_id: record.actorId,
    command_id: record.commandId,
    command_type: record.commandType,
    payload: record.payload,
    accepted_at: record.acceptedAt
  })
  const sql = {
    query: async (query: string, values?: readonly unknown[]) => {
      calls.push({ sql: query, values })
      if (/SELECT[\s\S]+FROM attacks WHERE id/.test(query)) {
        return { rows: [row(current)], rowCount: 1 }
      }
      if (/SELECT[\s\S]+FROM attack_commands/.test(query)) {
        return { rows: storedCommand ? [commandRow(storedCommand)] : [], rowCount: storedCommand ? 1 : 0 }
      }
      if (/INSERT INTO attack_commands/.test(query)) {
        storedCommand = command
        return { rows: [], rowCount: 1 }
      }
      if (/UPDATE attacks SET[\s\S]+authority =/.test(query)) {
        current = attackRecordWithAuthority(
          current,
          values?.[14] as AttackAggregate,
          values?.[10] as Date,
          { replacing: true }
        )
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    }
  } as unknown as SqlExecutor
  const postgres = new PostgresUnitOfWork(sql)

  await postgres.attacks.insert(prepared.record)
  assert.match(calls[0]!.sql, /authority/)
  assert.deepEqual(calls[0]!.values?.[22], prepared.authority)
  assert.equal(await postgres.attacks.compareAndSwapAuthority({
    attackId: prepared.record.id,
    expectedState: 'preparing',
    expectedVersion: prepared.authority.version,
    authority: engaged,
    updatedAt: new Date(NOW.getTime() + 1_000)
  }), true)
  assert.deepEqual((await postgres.attacks.get(prepared.record.id))?.authority, engaged)
  const write = {
    attackId: prepared.record.id,
    expectedState: 'engaged' as const,
    expectedVersion: engaged.version,
    authority: surrendered,
    updatedAt: new Date(NOW.getTime() + 2_000),
    command
  }
  assert.equal(await postgres.attacks.commitAuthorityCommand(write), 'inserted')
  assert.equal(await postgres.attacks.commitAuthorityCommand(write), 'duplicate')
  assert.deepEqual(await postgres.attacks.listCommands({
    attackId: prepared.record.id,
    afterSequence: 0,
    limit: 10
  }), [command])
  assert(calls.some(call => /ORDER BY sequence[\s\S]+LIMIT/.test(call.sql)))
  assert.deepEqual(await postgres.attacks.listActiveForPlayers([
    prepared.record.attackerId,
    prepared.record.defenderId!
  ], 20), [])
  const participantQuery = calls.find(call => /attacker_id = ANY/.test(call.sql))
  assert(participantQuery)
  assert.deepEqual(participantQuery.values?.[0], [prepared.record.attackerId, prepared.record.defenderId])
  assert.equal(participantQuery.values?.[2], 20)
})

test('bounded request-path migration installs every ordered read index', () => {
  const migration = MIGRATIONS.find(item => item.name === 'bounded_query_paths')
  assert.equal(migration?.version, 5)
  for (const index of [
    'player_profiles_trophy_discovery_idx',
    'world_plots_atlas_window_idx',
    'attacks_active_incoming_idx',
    'notifications_history_page_idx',
    'notifications_unread_page_idx'
  ]) {
    assert.match(migration?.sql ?? '', new RegExp(index))
  }
})

test('attack aggregate authority has an additive checked migration', () => {
  const migration = MIGRATIONS.find(item => item.name === 'attack_aggregate_authority')
  assert.equal(migration?.version, 6)
  assert.match(migration?.sql ?? '', /RENAME COLUMN request_id TO command_id/)
  assert.match(migration?.sql ?? '', /ADD COLUMN authority jsonb/)
  assert.match(migration?.sql ?? '', /attacks_authority_projection_consistent/)
  assert.match(migration?.sql ?? '', /commandReceipts/)
  assert.match(migration?.sql ?? '', /authority IS NULL AND state IN \('settled', 'cancelled', 'expired'\)/)
  assert.match(migration?.sql ?? '', /attacks_active_participant_attacker_idx/)
  assert.match(migration?.sql ?? '', /attacks_active_participant_defender_idx/)
})

test('presentation replay storage has durable byte accounting and retention indexes', () => {
  const migration = MIGRATIONS.find(item => item.name === 'bounded_presentation_replays')
  assert.equal(migration?.version, 8)
  assert.match(migration?.sql ?? '', /CREATE TABLE replay_presentation_usage/)
  assert.match(migration?.sql ?? '', /attacks_terminal_replay_retention_idx/)
  assert.match(migration?.sql ?? '', /replay_chunks_presentation_retention_idx/)
})

test('auxiliary storage has finite notification, idempotency, outbox, and marker retention', async () => {
  const migration = MIGRATIONS.find(item => item.name === 'bounded_auxiliary_retention')
  assert.equal(migration?.version, 9)
  assert.match(migration?.sql ?? '', /retention_rank > 50/)
  assert.match(migration?.sql ?? '', /outbox_published_retention_idx/)
  assert.match(migration?.sql ?? '', /outbox_unpublished_retention_idx/)
  assert.match(migration?.sql ?? '', /operation_markers_retention_idx/)

  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('retention-player'))
    for (let index = 0; index < 55; index += 1) {
      await tx.notifications.add({
        playerId: 'retention-player',
        id: `notice-${String(index).padStart(2, '0')}`,
        eventType: 'attack',
        payload: { index },
        occurredAt: new Date(NOW.getTime() + index),
        readAt: null
      })
    }
    const retained = await tx.notifications.listForPlayer({ playerId: 'retention-player', limit: 100 })
    assert.equal(retained.length, 50)
    assert.equal(retained[0]?.id, 'notice-54')
    assert.equal(retained[49]?.id, 'notice-05')

    const old = new Date(NOW.getTime() - 10 * 86_400_000)
    const future = new Date(NOW.getTime() + 60_000)
    await tx.idempotency.claim('retention-player', 'old', 'old', old, new Date(old.getTime() + 1_000))
    await tx.idempotency.complete('retention-player', 'old', 'old', { ok: true })
    await tx.idempotency.claim('retention-player', 'live', 'live', NOW, future)
    await tx.idempotency.complete('retention-player', 'live', 'live', { ok: true })
    assert.equal(await tx.idempotency.pruneExpired(NOW, 10), 1)

    const publishedId = await tx.outbox.add(outboxEvent({
      topic: 'retention', aggregateType: 'player', aggregateId: 'retention-player',
      eventType: 'published', now: old
    }))
    const claimedPublished = await tx.outbox.claimBatch('publisher', old, new Date(old.getTime() + 1_000), 1)
    assert.equal(claimedPublished[0]?.id, publishedId)
    assert.equal(await tx.outbox.markPublished(publishedId, 'publisher', old), true)
    const lockedId = await tx.outbox.add(outboxEvent({
      topic: 'retention', aggregateType: 'player', aggregateId: 'retention-player',
      eventType: 'locked', now: old
    }))
    const claimedLocked = await tx.outbox.claimBatch('live-worker', NOW, future, 1)
    assert.equal(claimedLocked[0]?.id, lockedId)
    await tx.outbox.add(outboxEvent({
      topic: 'retention', aggregateType: 'player', aggregateId: 'retention-player',
      eventType: 'expired', now: old
    }))
    await tx.outbox.add(outboxEvent({
      topic: 'retention', aggregateType: 'player', aggregateId: 'retention-player',
      eventType: 'fresh', now: NOW
    }))
    assert.deepEqual(await tx.outbox.prune(
      new Date(NOW.getTime() - 86_400_000),
      new Date(NOW.getTime() - 7 * 86_400_000),
      NOW,
      10
    ), { published: 1, expired: 1 })

    await tx.operationMarkers.add('retention-player', 'merchant', 'old', old)
    await tx.operationMarkers.add('retention-player', 'merchant', 'current', NOW)
    assert.equal(await tx.operationMarkers.pruneBefore(
      new Date(NOW.getTime() - 2 * 86_400_000),
      10
    ), 1)
    assert.equal(await tx.operationMarkers.has('retention-player', 'merchant', 'old'), false)
    assert.equal(await tx.operationMarkers.has('retention-player', 'merchant', 'current'), true)
  })
})

test('world concurrency migration repairs stale free rows and indexes guest cleanup', () => {
  const migration = MIGRATIONS.find(item => item.name === 'world_allocation_concurrency')
  assert.equal(migration?.version, 10)
  assert.match(migration?.sql ?? '', /DELETE FROM world_released_slots/)
  assert.match(migration?.sql ?? '', /world_plots_guest_reaper_idx/)
})

test('idempotency replays the exact committed response and outbox event', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => tx.accounts.insert(account('actor')))
  let mutations = 0
  const run = () => persistence.transaction(async tx => idempotentMutation(tx, {
    actorId: 'actor',
    operation: 'train',
    requestId: 'request-1',
    now: NOW,
    expiresAt: new Date(NOW.getTime() + 86_400_000)
  }, async () => {
    mutations += 1
    await tx.outbox.add(outboxEvent({
      topic: 'village',
      aggregateType: 'player',
      aggregateId: 'actor',
      eventType: 'troop-trained',
      payload: { count: 1 },
      now: NOW
    }))
    return { count: 1 }
  }))
  assert.deepEqual(await run(), { replayed: false, response: { count: 1 } })
  assert.deepEqual(await run(), { replayed: true, response: { count: 1 } })
  assert.equal(mutations, 1)
  await persistence.transaction(async tx => {
    const events = await tx.outbox.claimBatch('worker', NOW, new Date(NOW.getTime() + 30_000), 10)
    assert.equal(events.length, 1)
    assert.equal(await tx.outbox.markPublished(events[0]!.id, 'worker', NOW), true)
  })
})

test('selection is concurrent but engagement obtains one defender lease', async () => {
  const persistence = new MemoryPersistence()
  const attackA = preparedAuthority('attack-a', 'attacker-a', 'defender')
  const attackB = preparedAuthority('attack-b', 'attacker-b', 'defender')
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('attacker-a'))
    await tx.accounts.insert(account('attacker-b'))
    await tx.accounts.insert(account('defender'))
    await tx.attacks.insert(attackA.record)
    await tx.attacks.insert(attackB.record)
  })
  await persistence.transaction(async tx => {
    assert.equal(await tx.attacks.compareAndSwapAuthority({
      attackId: attackA.record.id,
      expectedState: 'preparing',
      expectedVersion: attackA.authority.version,
      authority: engagedAuthority(attackA.authority),
      updatedAt: new Date(NOW.getTime() + 1_000)
    }), true)
  })
  await assert.rejects(persistence.transaction(async tx => {
    await tx.attacks.compareAndSwapAuthority({
      attackId: attackB.record.id,
      expectedState: 'preparing',
      expectedVersion: attackB.authority.version,
      authority: engagedAuthority(attackB.authority),
      updatedAt: new Date(NOW.getTime() + 1_000)
    })
  }), /defender already has an active attack lease/i)
  await persistence.transaction(async tx => {
    assert.equal((await tx.attacks.get('attack-b'))?.state, 'preparing')
  })
})

test('bot targets use the same attack aggregate without a defender account', async () => {
  const persistence = new MemoryPersistence()
  const attack = preparedBotAuthority()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('attacker'))
    await tx.attacks.insert(attack.record)
    assert.equal((await tx.attacks.get(attack.record.id))?.targetKind, 'bot')
  })
})

test('non-terminal attacks cannot fall back to a coarse relational record', async () => {
  const persistence = new MemoryPersistence()
  await assert.rejects(persistence.transaction(async tx => {
    await tx.accounts.insert(account('coarse-attacker'))
    await tx.accounts.insert(account('coarse-defender'))
    await tx.attacks.insert(playerAttack('coarse-attack', 'coarse-attacker', 'coarse-defender'))
  }), /complete authority aggregate/i)
})

test('full attack authority and its command audit row commit under one CAS', async () => {
  const persistence = new MemoryPersistence()
  const prepared = preparedAuthority()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('authority-attacker'))
    await tx.accounts.insert(account('authority-defender'))
    await tx.attacks.insert(prepared.record)
  })

  const engaged = engagedAuthority(prepared.authority)
  assert.equal(await persistence.transaction(tx => tx.attacks.compareAndSwapAuthority({
    attackId: prepared.record.id,
    expectedState: 'preparing',
    expectedVersion: prepared.authority.version,
    authority: engaged,
    updatedAt: new Date(NOW.getTime() + 1_000)
  })), true)
  assert.equal(await persistence.transaction(tx => tx.attacks.compareAndSwapAuthority({
    attackId: prepared.record.id,
    expectedState: 'preparing',
    expectedVersion: prepared.authority.version,
    authority: engaged,
    updatedAt: new Date(NOW.getTime() + 1_000)
  })), false)

  const surrendered = applyAttackCommand(engaged, {
    expectedPhase: engaged.phase,
    expectedVersion: engaged.version
  }, {
    type: 'SURRENDER',
    commandId: 'command-surrender',
    sequence: 1
  }, NOW.getTime() + 2_000).attack
  const command = attackCommandsFromAuthority(surrendered)[0]!
  const rewritten = structuredClone(surrendered)
  rewritten.attackerName = 'Rewritten Attacker'
  await assert.rejects(persistence.transaction(tx => tx.attacks.compareAndSwapAuthority({
    attackId: prepared.record.id,
    expectedState: 'engaged',
    expectedVersion: engaged.version,
    authority: rewritten,
    updatedAt: new Date(NOW.getTime() + 2_000)
  })), /rewrote immutable attackerName/i)
  const write = {
    attackId: prepared.record.id,
    expectedState: 'engaged' as const,
    expectedVersion: engaged.version,
    authority: surrendered,
    updatedAt: new Date(NOW.getTime() + 2_000),
    command
  }
  assert.equal(await persistence.transaction(tx => tx.attacks.commitAuthorityCommand(write)), 'inserted')
  assert.equal(await persistence.transaction(tx => tx.attacks.commitAuthorityCommand(write)), 'duplicate')

  await persistence.transaction(async tx => {
    const stored = await tx.attacks.get(prepared.record.id)
    assert.equal(stored?.state, 'cancelled')
    assert.equal(stored?.stateVersion, surrendered.version)
    assert.deepEqual(stored?.authority, surrendered)
    assert.deepEqual(await tx.attacks.listCommands({
      attackId: prepared.record.id,
      afterSequence: 0,
      limit: 10
    }), [command])
    assert.deepEqual(await tx.attacks.listCommands({
      attackId: prepared.record.id,
      afterSequence: 1,
      limit: 10
    }), [])
    await assert.rejects(tx.attacks.listCommands({
      attackId: prepared.record.id,
      afterSequence: -1,
      limit: 10
    }), /afterSequence/i)
  })

  await assert.rejects(persistence.transaction(tx => tx.attacks.commitAuthorityCommand({
    ...write,
    command: { ...command, payload: { ...command.payload, type: 'ABILITY' } }
  })), /different content or authority/i)
})

test('legacy importer preserves valid aggregate authority and reconstructs its command log', () => {
  const prepared = preparedAuthority('legacy-authority')
  const engaged = engagedAuthority(prepared.authority)
  const surrendered = applyAttackCommand(engaged, {
    expectedPhase: engaged.phase,
    expectedVersion: engaged.version
  }, { type: 'SURRENDER', commandId: 'legacy-surrender', sequence: 1 }, NOW.getTime() + 2_000).attack
  const record = mapLegacyReplayAttack({
    collection: 'replays',
    key: surrendered.attackId,
    sha256: 'a'.repeat(64),
    value: {
      attackId: surrendered.attackId,
      attackerId: surrendered.attackerId,
      victimId: surrendered.target.kind === 'PLAYER' ? surrendered.target.playerId : '',
      victimPlotX: surrendered.target.plot.x,
      victimPlotY: surrendered.target.plot.y,
      victimPlotVersion: 1,
      status: 'aborted',
      startedAt: surrendered.timestamps.createdAt,
      updatedAt: NOW.getTime() + 2_000,
      ownerTokenHash: 'legacy-token',
      authority: surrendered as unknown as JsonObject,
      frames: []
    }
  })
  assert.deepEqual(record.authority, surrendered)
  assert.equal(record.state, 'cancelled')
  assert.deepEqual(attackCommandsFromAuthority(record.authority!), [{
    attackId: surrendered.attackId,
    sequence: 1,
    actorId: surrendered.attackerId,
    commandId: 'legacy-surrender',
    commandType: 'SURRENDER',
    payload: { commandId: 'legacy-surrender', sequence: 1, type: 'SURRENDER' },
    acceptedAt: new Date((surrendered.timestamps.engagedAt ?? surrendered.timestamps.createdAt))
  }])
})

test('world allocation, generation pinning, reusable slots, and guest leases are transactional', async () => {
  const persistence = new MemoryPersistence()
  const expiresAt = new Date(NOW.getTime() + 100)
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('guest'))
    await tx.accounts.insert(account('expired-guest'))
    await tx.accounts.insert(account('slot-consumer'))
    await tx.world.insertAllocation({
      worldId: 'main',
      schemaVersion: 1,
      regionSize: 32,
      currentGenerationVersion: 1,
      nextOrdinal: 5,
      revision: 0,
      updatedAt: NOW
    })
    const region = {
      worldId: 'main',
      regionId: 'main|g1|r0,0|s32',
      regionX: 0,
      regionY: 0,
      size: 32,
      generationVersion: 1,
      createdAt: NOW
    }
    assert.equal(await tx.world.ensureRegion(region), 'inserted')
    assert.equal(await tx.world.ensureRegion(region), 'existing')
    await assert.rejects(
      tx.world.ensureRegion({ ...region, generationVersion: 2 }),
      /immutable/i
    )
    await tx.world.assign({
      worldId: 'main',
      x: 1,
      y: 1,
      regionId: region.regionId,
      playerId: 'guest',
      plotVersion: 1,
      assignedAt: NOW,
      leaseId: 'lease-guest',
      leaseIssuedAt: NOW,
      leaseRenewedAt: NOW,
      leaseExpiresAt: expiresAt
    })
    await tx.world.assign({
      worldId: 'main',
      x: 2,
      y: 2,
      regionId: region.regionId,
      playerId: 'expired-guest',
      plotVersion: 3,
      assignedAt: new Date(NOW.getTime() - 200),
      leaseId: 'lease-expired',
      leaseIssuedAt: new Date(NOW.getTime() - 200),
      leaseRenewedAt: new Date(NOW.getTime() - 100),
      leaseExpiresAt: NOW
    })
    assert.deepEqual(
      await tx.world.claimExpiredGuestAccountIds('main', NOW, 10),
      ['expired-guest']
    )
    assert.equal(await tx.world.renewGuestLease(
      'guest',
      'lease-guest',
      new Date(NOW.getTime() + 50),
      new Date(NOW.getTime() + 200)
    ), true)
    assert.equal((await tx.world.getPlayerPlot('guest'))?.leaseExpiresAt?.getTime(), NOW.getTime() + 200)
    assert.equal(await tx.world.promoteGuestLease(
      'guest',
      'lease-guest',
      new Date(NOW.getTime() + 199)
    ), true)
    assert.equal((await tx.world.getPlayerPlot('guest'))?.leaseId, null)

    await tx.world.putReleasedSlot({ worldId: 'main', ordinal: 10, plotVersion: 2, releasedAt: NOW })
    await tx.world.putReleasedSlot({ worldId: 'main', ordinal: 3, plotVersion: 4, releasedAt: NOW })
    await tx.world.putReleasedSlot({ worldId: 'main', ordinal: 3, plotVersion: 2, releasedAt: NOW })
    assert.deepEqual(await tx.world.getReleasedSlots('main', 1), [{
      worldId: 'main', ordinal: 3, plotVersion: 4, releasedAt: NOW
    }])
    assert.deepEqual((await tx.world.getReleasedSlots('main', 1, { excludeOrdinals: [3] }))
      .map(slot => slot.ordinal), [10])
    assert.equal(await tx.world.deleteReleasedSlots('main', [3, 3]), 1)

    const consumedOrdinal = allocationOrdinalOf({ x: 3, y: 3 })
    await tx.world.putReleasedSlot({
      worldId: 'main', ordinal: consumedOrdinal, plotVersion: 7, releasedAt: NOW
    })
    await tx.world.assign({
      worldId: 'main', x: 3, y: 3, regionId: region.regionId, playerId: 'slot-consumer',
      plotVersion: 7, assignedAt: NOW,
      leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
    })
    assert.equal(await tx.world.getReleasedSlot('main', consumedOrdinal), null,
      'a successful claim atomically consumes the same-coordinate released slot')

    const allocation = (await tx.world.getAllocation('main'))!
    assert.equal(await tx.world.updateAllocation({
      ...allocation,
      nextOrdinal: 11,
      revision: 1,
      updatedAt: new Date(NOW.getTime() + 1)
    }, 0), true)
    assert.equal(await tx.world.updateAllocation({ ...allocation, revision: 1 }, 0), false)
  })
})

test('leaderboard, matchmaking, and atlas reads are bounded and eligibility-aware', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => {
    const accounts = [
      account('attacker', { trophies: 100 }),
      account('eligible-high', { trophies: 104 }),
      account('eligible-low', { trophies: 98 }),
      account('shielded', { trophies: 103, shieldUntil: new Date(NOW.getTime() + 60_000) }),
      account('no-village', { trophies: 105 }),
      account('leased', { trophies: 99 }),
      account('lease-attacker', { trophies: 20 }),
      account('other-world', { trophies: 101 })
    ]
    for (const record of accounts) await tx.accounts.insert(record)
    for (const record of accounts.filter(record => record.id !== 'no-village' && record.id !== 'lease-attacker')) {
      const storedVillage = village(record.id, record.id === 'eligible-low' ? 7 : 1)
      if (record.id === 'eligible-low') storedVillage.banner = { palette: 3, emblem: 5, pattern: 2 }
      await tx.villages.insert(storedVillage)
    }

    const mainRegion = {
      worldId: 'main', regionId: 'main|g1|r0,0|s32', regionX: 0, regionY: 0,
      size: 32, generationVersion: 1, createdAt: NOW
    }
    const otherRegion = { ...mainRegion, worldId: 'other', regionId: 'other|g1|r0,0|s32' }
    await tx.world.ensureRegion(mainRegion)
    await tx.world.ensureRegion(otherRegion)
    const plotted = ['attacker', 'eligible-high', 'eligible-low', 'shielded', 'no-village', 'leased']
    for (const [index, playerId] of plotted.entries()) {
      await tx.world.assign({
        worldId: 'main', x: index, y: 0, regionId: mainRegion.regionId, playerId,
        plotVersion: 1, assignedAt: NOW,
        leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
      })
    }
    await tx.world.assign({
      worldId: 'other', x: 0, y: 0, regionId: otherRegion.regionId, playerId: 'other-world',
      plotVersion: 1, assignedAt: NOW,
      leaseId: null, leaseIssuedAt: null, leaseRenewedAt: null, leaseExpiresAt: null
    })

    const lease = preparedAuthority('leased-defense', 'lease-attacker', 'leased', 5, 0)
    await tx.attacks.insert(lease.record)
    assert.equal(await tx.attacks.compareAndSwapAuthority({
      attackId: lease.record.id,
      expectedState: 'preparing',
      expectedVersion: lease.authority.version,
      authority: engagedAuthority(lease.authority),
      updatedAt: new Date(NOW.getTime() + 1_000)
    }), true)

    assert.deepEqual((await tx.accounts.listLeaderboard({ limit: 3 })).map(player => player.playerId), [
      'no-village', 'eligible-high', 'shielded'
    ])
    await assert.rejects(tx.accounts.listLeaderboard({ limit: 0 }), /positive safe integer/i)

    const candidates = await tx.attacks.findCandidates({
      attackerId: 'attacker',
      worldId: 'main',
      targetTrophies: 100,
      trophyRadius: 10,
      now: NOW,
      limit: 10
    })
    assert.deepEqual(candidates.map(candidate => candidate.player.playerId), ['eligible-low', 'eligible-high'])
    assert.deepEqual(candidates.map(candidate => candidate.trophyDistance), [2, 4])
    await assert.rejects(tx.attacks.findCandidates({
      attackerId: 'attacker', worldId: 'main', targetTrophies: 100,
      trophyRadius: 10_001, now: NOW, limit: 1
    }), /trophyRadius/i)

    const atlas = await tx.world.listAtlas({
      worldId: 'main', minX: 1, maxX: 2, minY: 0, maxY: 0, now: NOW, limit: 10
    })
    assert.deepEqual(atlas.map(entry => entry.player.playerId), ['eligible-high', 'eligible-low'])
    assert.equal(atlas[1]?.village.appearanceRevision, 7)
    assert.deepEqual(atlas[1]?.village.banner, { palette: 3, emblem: 5, pattern: 2 })
    assert.deepEqual(atlas[1]?.village.buildings, [
      { id: 'townhall-eligible-low', type: 'townhall', x: 0, y: 0 }
    ])
    const atlasPlayers = await tx.world.listPlayers({
      worldId: 'main', minX: 1, maxX: 2, minY: 0, maxY: 0, now: NOW, limit: 10
    })
    assert.deepEqual(atlasPlayers.map(entry => entry.banner), [
      null,
      { palette: 3, emblem: 5, pattern: 2 }
    ])
    const globalPlayers = await tx.world.listPlayersGlobal({
      worldId: 'main', centerX: 5, centerY: 0, now: NOW, limit: 3
    })
    assert.deepEqual(globalPlayers.map(entry => entry.player.playerId), [
      'leased', 'shielded', 'eligible-low'
    ])
    await assert.rejects(tx.world.listAtlas({
      worldId: 'main', minX: 0, maxX: 256, minY: 0, maxY: 0, now: NOW, limit: 1
    }), /may not exceed/i)
  })
})

test('active attacks, participant replays, and notification pages are bounded', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('replay-attacker'))
    await tx.accounts.insert(account('replay-defender'))
    await tx.accounts.insert(account('outsider'))
    const prepared = preparedAuthority('active-attack', 'replay-attacker', 'replay-defender')
    await tx.attacks.insert(prepared.record)
    assert.equal(await tx.attacks.compareAndSwapAuthority({
      attackId: prepared.record.id,
      expectedState: 'preparing',
      expectedVersion: prepared.authority.version,
      authority: engagedAuthority(prepared.authority),
      updatedAt: new Date(NOW.getTime() + 1_000)
    }), true)
    const active = (await tx.attacks.get(prepared.record.id))!

    assert.deepEqual((await tx.attacks.listActiveOutgoing('replay-attacker', 1)).map(item => item.id), ['active-attack'])
    assert.deepEqual((await tx.attacks.listActiveIncoming('replay-defender', 1)).map(item => item.id), ['active-attack'])
    assert.deepEqual((await tx.attacks.listActiveForPlayers(['replay-defender', 'outsider'], 10))
      .map(item => item.id), ['active-attack'])
    assert.deepEqual(await tx.attacks.claimDue(NOW, 10), [])
    assert.deepEqual((await tx.attacks.claimDue(new Date(NOW.getTime() + 24 * 60 * 60_000), 10))
      .map(item => item.id), ['active-attack'])
    await assert.rejects(tx.attacks.claimDue(new Date(Number.NaN), 10), /valid Date/i)
    assert.deepEqual(await tx.attacks.listActiveForPlayers([], 10), [])
    await assert.rejects(
      tx.attacks.listActiveForPlayers(Array.from({ length: 1_025 }, (_, index) => `player-${index}`), 10),
      /playerIds may not exceed/i
    )
    await assert.rejects(tx.attacks.listActiveIncoming('replay-defender', 0), /positive safe integer/i)

    const chunk0 = {
      attackId: active.id, sequence: 0, format: 'commands-v1', payload: { commands: [] },
      objectKey: null, checksum: 'chunk-0', createdAt: NOW
    }
    const chunk1 = {
      ...chunk0, sequence: 1, payload: null, objectKey: 'replays/active-attack/1', checksum: 'chunk-1'
    }
    assert.equal(await tx.replays.append(chunk0), 'inserted')
    assert.equal(await tx.replays.append(chunk0), 'duplicate')
    assert.equal(await tx.replays.append(chunk1), 'inserted')
    assert.deepEqual((await tx.replays.listForParticipant({
      attackId: active.id, participantId: 'replay-attacker', afterSequence: -1, limit: 1
    })).map(chunk => chunk.sequence), [0])
    assert.deepEqual((await tx.replays.listForParticipant({
      attackId: active.id, participantId: 'replay-defender', afterSequence: 0, limit: 10
    })).map(chunk => chunk.sequence), [1])
    assert.deepEqual(await tx.replays.listForParticipant({
      attackId: active.id, participantId: 'outsider', afterSequence: -1, limit: 10
    }), [])

    const older = {
      playerId: 'replay-defender', id: 'notice-a', eventType: 'attack', payload: { attackId: active.id },
      occurredAt: new Date(NOW.getTime() - 1_000), readAt: null
    }
    const newer = {
      ...older, id: 'notice-b', occurredAt: NOW, readAt: NOW
    }
    assert.equal(await tx.notifications.add(older), 'inserted')
    assert.equal(await tx.notifications.add(newer), 'inserted')
    assert.deepEqual((await tx.notifications.listForPlayer({
      playerId: 'replay-defender', limit: 1
    })).map(notification => notification.id), ['notice-b'])
    assert.deepEqual((await tx.notifications.listForPlayer({
      playerId: 'replay-defender', before: { occurredAt: NOW, id: 'notice-b' }, limit: 10
    })).map(notification => notification.id), ['notice-a'])
    assert.deepEqual((await tx.notifications.listForPlayer({
      playerId: 'replay-defender', unreadOnly: true, limit: 10
    })).map(notification => notification.id), ['notice-a'])
  })
})

test('balance ledger deduplicates effects and counts colliding request ids per player', async () => {
  const persistence = new MemoryPersistence()
  await persistence.transaction(async tx => {
    await tx.accounts.insert(account('ledger-player'))
    await tx.accounts.insert(account('ledger-player-2'))
    const entry = {
      playerId: 'ledger-player',
      operation: 'attack-settlement',
      requestId: 'attack-1',
      currency: 'gold' as const,
      delta: 25,
      balanceAfter: 125,
      metadata: { attackId: 'attack-1' },
      createdAt: NOW
    }
    assert.equal(await tx.balanceLedger.append(entry), 'inserted')
    assert.equal(await tx.balanceLedger.append(entry), 'duplicate')
    await assert.rejects(tx.balanceLedger.append({ ...entry, delta: 999 }), /different effect/i)
    assert.equal(await tx.balanceLedger.append({
      ...entry,
      playerId: 'ledger-player-2',
      balanceAfter: 25
    }), 'inserted')
    const day = Math.floor(NOW.getTime() / 86_400_000)
    const summary = await tx.balanceLedger.summarizeDays(day, day)
    assert.equal(summary[0]?.operationCount, 2)
  })
})

test('legacy validation blocks an unsealed JSON directory', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-legacy-'))
  try {
    mkdirSync(path.join(dataRoot, 'players'))
    writeFileSync(path.join(dataRoot, 'players', 'player-1.json'), JSON.stringify({
      id: 'player-1',
      tokenHashes: ['a'.repeat(64)],
      username: 'Chief',
      createdAt: NOW.getTime(),
      lastSeen: NOW.getTime(),
      trophies: 10,
      balance: 1_000,
      lastAccrualAt: NOW.getTime(),
      lastMutationAt: NOW.getTime(),
      revision: 1,
      buildings: [],
      obstacles: [],
      army: {},
      wallLevel: 1,
      requestKeys: [],
      population: { count: 1, lastGrowthAt: NOW.getTime() },
      ore: 25,
      food: 50,
      plotX: -3,
      plotY: -2,
      productionRemainders: { ore: 0, food: 0 }
    }))
    const plan = buildLegacyImportPlan(dataRoot, NOW)
    assert.equal(plan.counts.players, 1)
    assert(plan.issues.some(issue => issue.code === 'FROZEN_SNAPSHOT'))
    assert(plan.issues.some(issue => issue.code === 'SIMULATION_CHECKPOINT'))
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
