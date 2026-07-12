import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildLegacyImportPlan } from './legacy-import'
import {
  LEGACY_COLLECTIONS,
  materializeLegacySnapshot,
  verifyFrozenLegacySnapshot
} from './legacy-snapshot'

const START = Date.parse('2026-07-11T12:00:00.000Z')
const CUTOFF = new Date(START + 10_000)

function writeRecord(root: string, collection: string, key: string, value: unknown, pretty = false): string {
  const directory = path.join(root, collection)
  mkdirSync(directory, { recursive: true })
  const raw = JSON.stringify(value, null, pretty ? 2 : undefined)
  writeFileSync(path.join(directory, `${key}.json`), raw)
  return raw
}

function player(id = 'player-1') {
  return {
    id,
    tokenHashes: ['a'.repeat(64)],
    username: 'Chief',
    createdAt: START,
    lastSeen: START,
    trophies: 10,
    balance: 1_000,
    lastAccrualAt: START,
    lastMutationAt: START,
    revision: 7,
    buildings: [{
      id: 'town-hall',
      type: 'town_hall',
      gridX: 10,
      gridY: 10,
      level: 1,
    }, {
      id: 'watchtower',
      type: 'watchtower',
      gridX: 14,
      gridY: 10,
      level: 1,
      upgradingTo: 2,
      upgradeEndsAt: START + 1_000
    }],
    obstacles: [],
    army: {},
    wallLevel: 1,
    requestKeys: [],
    population: { count: 3, lastGrowthAt: START - 180_000 },
    ore: 25,
    food: 50,
    plotX: -3,
    plotY: -2,
    productionRemainders: { ore: 0, food: 0 }
  }
}

function sourceDirectory(root: string): { playerRaw: string; replayRaw: string } {
  for (const collection of LEGACY_COLLECTIONS) mkdirSync(path.join(root, collection), { recursive: true })
  const playerRaw = writeRecord(root, 'players', 'player-1', player(), true)
  const replayRaw = writeRecord(root, 'replays', 'attack-1', {
    attackId: 'attack-1',
    attackerId: 'player-1',
    victimId: 'player-1',
    status: 'aborted',
    frames: []
  }, true)
  writeRecord(root, 'bot-raids', 'raid-1', {
    raidId: 'raid-1',
    attackerId: 'player-1',
    status: 'aborted'
  })
  writeRecord(root, 'notifications', 'player-1', { items: [] })
  writeRecord(root, 'world-state', 'main', {
    allocation: {
      schemaVersion: 1,
      worldId: 'main',
      regionSize: 32,
      currentGenerationVersion: 1,
      nextOrdinal: 27
    },
    releasedSlots: []
  })
  return { playerRaw, replayRaw }
}

test('legacy cutover materializes one deterministic, sealed, read-only snapshot', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'clash-cutover-'))
  const source = path.join(parent, 'source')
  const outputA = path.join(parent, 'frozen-a')
  const outputB = path.join(parent, 'frozen-b')
  mkdirSync(source)
  const originals = sourceDirectory(source)
  try {
    const first = materializeLegacySnapshot({ dataRoot: source, outputRoot: outputA, cutoffAt: CUTOFF })
    const second = materializeLegacySnapshot({ dataRoot: source, outputRoot: outputB, cutoffAt: CUTOFF })

    assert.equal(readFileSync(path.join(source, 'players/player-1.json'), 'utf8'), originals.playerRaw)
    assert.equal(readFileSync(path.join(source, 'replays/attack-1.json'), 'utf8'), originals.replayRaw)
    assert.equal(readFileSync(path.join(outputA, 'replays/attack-1.json'), 'utf8'), originals.replayRaw)
    assert.equal(first.manifest.snapshotSha256, second.manifest.snapshotSha256)
    assert.equal(
      readFileSync(path.join(outputA, 'players/player-1.json'), 'utf8'),
      readFileSync(path.join(outputB, 'players/player-1.json'), 'utf8')
    )

    const frozen = JSON.parse(readFileSync(path.join(outputA, 'players/player-1.json'), 'utf8'))
    assert.equal(frozen.lastAccrualAt, CUTOFF.getTime())
    assert.equal(frozen.simulatedThrough, CUTOFF.getTime())
    assert.equal(frozen.simulationVersion, 2)
    assert(frozen.nextEventAt > CUTOFF.getTime())
    assert.equal(frozen.revision, 7)
    assert.equal(frozen.layoutRevision, 7)
    assert.equal(frozen.appearanceRevision, 9)
    assert.equal(frozen.buildings[1].level, 2)
    assert.equal(frozen.buildings[1].upgradingTo, undefined)
    assert.equal(frozen.population.count, 4)
    assert.equal(first.manifest.players.completedUpgrades, 1)
    assert.equal(first.manifest.players.births, 1)
    assert.equal(first.manifest.players.appearanceRevisionsAdvanced, 1)
    assert.deepEqual(verifyFrozenLegacySnapshot(outputA, CUTOFF), [])
    assert.deepEqual(buildLegacyImportPlan(outputA, CUTOFF).issues, [])
    assert.equal(first.manifest.collections['world-state'].records, 1)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('legacy cutover refuses live PvP and bot attacks without publishing output', () => {
  for (const live of [
    { collection: 'replays', key: 'live-attack', value: { attackId: 'live-attack', status: 'live' } },
    { collection: 'bot-raids', key: 'live-raid', value: { raidId: 'live-raid', status: 'settling' } }
  ] as const) {
    const parent = mkdtempSync(path.join(tmpdir(), 'clash-cutover-live-'))
    const source = path.join(parent, 'source')
    const output = path.join(parent, 'frozen')
    mkdirSync(source)
    const originals = sourceDirectory(source)
    writeRecord(source, live.collection, live.key, live.value)
    try {
      assert.throws(
        () => materializeLegacySnapshot({ dataRoot: source, outputRoot: output, cutoffAt: CUTOFF }),
        /every PvP and bot attack to be terminal/i
      )
      assert.equal(readFileSync(path.join(source, 'players/player-1.json'), 'utf8'), originals.playerRaw)
      assert.throws(() => readFileSync(path.join(output, 'cutover-manifest.json')), /ENOENT/)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }
})

test('legacy validation detects checksum tampering and requires a frozen materialized source', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'clash-cutover-verify-'))
  const source = path.join(parent, 'source')
  const output = path.join(parent, 'frozen')
  mkdirSync(source)
  sourceDirectory(source)
  try {
    const rawPlan = buildLegacyImportPlan(source, CUTOFF)
    assert(rawPlan.issues.some(issue => issue.code === 'FROZEN_SNAPSHOT'))
    assert(rawPlan.issues.some(issue => issue.code === 'UNMATERIALIZED_PLAYER'))

    materializeLegacySnapshot({ dataRoot: source, outputRoot: output, cutoffAt: CUTOFF })
    const playerPath = path.join(output, 'players/player-1.json')
    const tampered = JSON.parse(readFileSync(playerPath, 'utf8'))
    tampered.balance += 1
    writeFileSync(playerPath, JSON.stringify(tampered))
    const issues = buildLegacyImportPlan(output, CUTOFF).issues
    assert(issues.some(issue => issue.code === 'FROZEN_SNAPSHOT' && /checksum/i.test(issue.message)))
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('legacy cutover never permits its output inside the source tree', () => {
  const source = mkdtempSync(path.join(tmpdir(), 'clash-cutover-nested-'))
  sourceDirectory(source)
  try {
    assert.throws(() => materializeLegacySnapshot({
      dataRoot: source,
      outputRoot: path.join(source, 'frozen'),
      cutoffAt: CUTOFF
    }), /outside the source data directory/i)
  } finally {
    rmSync(source, { recursive: true, force: true })
  }
})

test('legacy cutover refuses a data directory still owned by a live server', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'clash-cutover-owned-'))
  const source = path.join(parent, 'source')
  const output = path.join(parent, 'frozen')
  mkdirSync(source)
  const originals = sourceDirectory(source)
  writeFileSync(path.join(source, '.clash-server.lock'), JSON.stringify({ pid: process.pid }))
  try {
    assert.throws(() => materializeLegacySnapshot({ dataRoot: source, outputRoot: output, cutoffAt: CUTOFF }), /owned by live server/i)
    assert.equal(readFileSync(path.join(source, 'players/player-1.json'), 'utf8'), originals.playerRaw)
    assert.throws(() => readFileSync(path.join(output, 'cutover-manifest.json')), /ENOENT/)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
