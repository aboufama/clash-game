import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BUILDING_DEFINITIONS,
  CORE_TROOP_TYPES,
  CORE_TROOP_UNLOCK_LEVELS,
  FACTION_BARRACKS,
  FACTION_TROOP_TYPES,
  GENERATED_ONLY,
  LEGACY_PLAYER_TROOP_TYPES,
  PLAYER_TROOP_TYPES,
  TRAINABLE_TROOP_TYPES,
  TROOP_DEFINITIONS,
  TROOP_FACTIONS,
  TROOP_TECH_TREES,
  factionUnlocksAtLevel,
  getCoreTroopUnlockLevel,
  getTroopFaction,
  getTroopUnlockLevel,
  troopTrainingRequirement,
  type FactionTroopType,
  type TroopFaction
} from '../src/game/config/GameDefinitions'
import {
  armyCampUnlockProgress,
  maxCompletedArmyCampLevel
} from '../src/game/config/Economy'
import { grantedSession } from './domain/auth'
import { sanitizeArmy } from './domain/village/layout'
import { ApiError, GameService } from './game'
import { MemoryPersistence } from './persistence'
import type { JsonValue } from './persistence'
import type { RuntimePrincipal } from './runtime/contracts'
import { PersistenceGameService } from './runtime/service'

// This spec mints guest sessions on both runtimes; opt into guest auto-play
// (the legacy GameService reads the env flag per call, the normalized runtime
// defaults its allowGuestSessions option from the same shared rule).
process.env.CLASH_ALLOW_GUESTS = '1'

const EXPECTED_TREES = {
  mystic: [
    'goblinplunderer',
    'wallbreaker',
    'stormmage',
    'necromancer',
    'warelephant',
    'golem',
    'icegolem'
  ],
  mechanica: [
    'clockworkbeetle',
    'ram',
    'mobilemortar',
    'siegetower',
    'trebuchet',
    'ornithopter',
    'davincitank'
  ]
} as const satisfies Record<TroopFaction, readonly FactionTroopType[]>

const BARRACKS_TYPES = new Set<string>(Object.values(FACTION_BARRACKS))
const REMOVED_TROOPS = [
  'needleback',
  'razorwing',
  'vatbrute',
  'apexchimera',
  'sporelobber',
  'mantisstalker',
  'riftdjinn',
  'graftling',
  'runesentinel',
  'rivetguard',
  'hexling',
  'genedragon'
] as const

test('two Barracks paths expose seven unlocks followed by L8-L9 Mastery', () => {
  assert.deepEqual(TROOP_FACTIONS, ['mystic', 'mechanica'])
  assert.deepEqual(FACTION_BARRACKS, {
    mystic: 'mystic_barracks',
    mechanica: 'barracks'
  })
  assert.equal((BUILDING_DEFINITIONS as Record<string, unknown>).biopunk_barracks, undefined)

  for (const faction of TROOP_FACTIONS) {
    const tree = TROOP_TECH_TREES[faction]
    const barracksType = FACTION_BARRACKS[faction]
    const barracks = BUILDING_DEFINITIONS[barracksType]
    assert(barracks, `${faction} must have a registered Barracks`)
    assert.equal(barracks.maxLevel, 9)
    assert.equal(barracks.levels?.length, 9)
    assert.deepEqual(barracks.levels?.[8], { hp: 1380, cost: 1900 })
    assert.deepEqual(tree, EXPECTED_TREES[faction])
    assert.equal(tree.length, 7)
    assert.equal(getTroopUnlockLevel(tree[6]), 7)
    assert.deepEqual(factionUnlocksAtLevel(faction, 7), [tree[6]])
    for (const level of [8, 9]) {
      assert.deepEqual(factionUnlocksAtLevel(faction, level), [])
    }
  }
})

test('Army Camp, faction, and generated troop catalogs are exact and disjoint', () => {
  assert.deepEqual(CORE_TROOP_TYPES, ['warrior', 'archer', 'physicianscart', 'phalanx'])
  assert.deepEqual(CORE_TROOP_UNLOCK_LEVELS, {
    warrior: 1,
    archer: 2,
    physicianscart: 3,
    phalanx: 4
  })
  assert.equal(TROOP_DEFINITIONS.warrior.name, 'Barbarian')
  assert.equal(TROOP_DEFINITIONS.physicianscart.name, 'Healer')
  assert.deepEqual(LEGACY_PLAYER_TROOP_TYPES, [])

  const flattened = TROOP_FACTIONS.flatMap(faction => [...TROOP_TECH_TREES[faction]])
  assert.deepEqual(flattened, [...FACTION_TROOP_TYPES])
  assert.equal(flattened.length, 14)
  assert.equal(new Set(flattened).size, 14)

  for (const faction of TROOP_FACTIONS) {
    TROOP_TECH_TREES[faction].forEach((troop, index) => {
      assert(TROOP_DEFINITIONS[troop])
      assert.equal(getTroopFaction(troop), faction)
      assert.equal(getTroopUnlockLevel(troop), index + 1)
      const requirement = troopTrainingRequirement(troop)
      assert(requirement && requirement.kind === 'barracks')
      assert.equal(requirement.faction, faction)
      assert.equal(requirement.barracksType, FACTION_BARRACKS[faction])
      assert.equal(requirement.unlockLevel, index + 1)
    })
  }

  CORE_TROOP_TYPES.forEach((troop, index) => {
    const unlockLevel = index + 1
    assert.equal(getCoreTroopUnlockLevel(troop), unlockLevel)
    assert.equal(getTroopUnlockLevel(troop), unlockLevel)
    assert.equal(getTroopFaction(troop), null)
    assert.deepEqual(troopTrainingRequirement(troop), {
      kind: 'core',
      campType: 'army_camp',
      campName: 'Army Camp',
      unlockLevel
    })
    assert(!flattened.includes(troop as FactionTroopType))
  })

  assert.deepEqual(TRAINABLE_TROOP_TYPES, [...CORE_TROOP_TYPES, ...flattened])
  assert.deepEqual(PLAYER_TROOP_TYPES, TRAINABLE_TROOP_TYPES)
  assert.equal(TRAINABLE_TROOP_TYPES.length, 18)
  assert.equal(new Set(TRAINABLE_TROOP_TYPES).size, 18)
  assert.equal(TROOP_DEFINITIONS.golem.name, 'Stone Golem')
  assert.equal(getTroopFaction('golem'), 'mystic')

  for (const generated of ['romanwarrior', 'skeleton'] as const) {
    assert(GENERATED_ONLY.has(generated))
    assert(!PLAYER_TROOP_TYPES.includes(generated as never))
    assert.equal(getTroopUnlockLevel(generated), Infinity)
    assert.equal(troopTrainingRequirement(generated), null)
  }

  for (const removed of REMOVED_TROOPS) {
    assert.equal((TROOP_DEFINITIONS as Record<string, unknown>)[removed], undefined)
    assert(!PLAYER_TROOP_TYPES.includes(removed as never))
  }
})

test('Army Camp progression uses the highest online completed camp only', () => {
  assert.deepEqual(armyCampUnlockProgress([]), {
    completedLevel: 0,
    upgradingToLevel: null,
    upgrading: false
  })
  const mixed = [
    { id: 'camp-online', type: 'army_camp' as const, gridX: 0, gridY: 0, level: 4 },
    { id: 'camp-upgrading', type: 'army_camp' as const, gridX: 4, gridY: 0, level: 2, upgradingTo: 3 },
    { id: 'other', type: 'barracks' as const, gridX: 8, gridY: 0, level: 9 }
  ]
  assert.deepEqual(armyCampUnlockProgress(mixed), {
    completedLevel: 4,
    upgradingToLevel: 3,
    upgrading: true
  })
  assert.equal(maxCompletedArmyCampLevel(mixed), 4)
  assert.equal(maxCompletedArmyCampLevel([
    { id: 'only-camp', type: 'army_camp', gridX: 0, gridY: 0, level: 3, upgradingTo: 4 }
  ]), 0)
})

test('removed Biopunk and Rift troop data self-cleans from authoritative armies', () => {
  const dirtyArmy = Object.fromEntries([
    ['warrior', 2],
    ['skeleton', 8],
    ...REMOVED_TROOPS.map(type => [type, 1] as const)
  ])
  assert.deepEqual({ ...sanitizeArmy(dirtyArmy) }, { warrior: 2 })
})

test('normalized runtime enforces Army Camp core unlocks and both Barracks paths', async () => {
  const persistence = new MemoryPersistence()
  const now = new Date('2026-07-18T12:00:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    infiniteResources: true
  })

  try {
    const session = grantedSession(await service.ensureSession('', 'two-path-runtime'))
    const principal: RuntimePrincipal = { playerId: session.player.id }

    const barbarian = await service.trainTroop(principal, {
      type: 'warrior', count: 1, requestId: 'camp-l1-barbarian-runtime'
    }) as { army: Record<string, number> }
    assert.equal(barbarian.army.warrior, 1)
    await assert.rejects(service.trainTroop(principal, {
      type: 'archer', count: 1, requestId: 'camp-l1-archer-runtime'
    }), error => error instanceof ApiError && error.status === 403 && /level 2 Army Camp/.test(error.message))

    await persistence.transaction(async tx => {
      const village = await tx.villages.get(principal.playerId, { forUpdate: true })
      assert(village)
      const expectedRevision = village.economyRevision
      village.buildings = (village.buildings as Array<Record<string, unknown>>).map(building => (
        building.type === 'army_camp'
          ? { ...building, upgradingTo: 2, upgradeEndsAt: now.getTime() + 60_000 }
          : building
      )) as JsonValue[]
      village.economyRevision = expectedRevision + 1
      assert.equal(await tx.villages.update(village, expectedRevision), true)
    })
    await assert.rejects(service.trainTroop(principal, {
      type: 'warrior', count: 1, requestId: 'offline-camp-runtime'
    }), error => error instanceof ApiError && error.status === 403 && /level 1 Army Camp/.test(error.message))

    await persistence.transaction(async tx => {
      const village = await tx.villages.get(principal.playerId, { forUpdate: true })
      assert(village)
      const expectedRevision = village.economyRevision
      village.buildings = (village.buildings as Array<Record<string, unknown>>)
        .filter(building => !BARRACKS_TYPES.has(String(building.type)))
        .map(building => {
          if (building.type !== 'army_camp') return building
          const online: Record<string, unknown> = { ...building, level: 4 }
          delete online.upgradingTo
          delete online.upgradeEndsAt
          return online
        }) as JsonValue[]
      village.economyRevision = expectedRevision + 1
      assert.equal(await tx.villages.update(village, expectedRevision), true)
    })

    for (const type of ['archer', 'physicianscart', 'phalanx'] as const) {
      const trained = await service.trainTroop(principal, {
        type, count: 1, requestId: `camp-l4-${type}-runtime`
      }) as { army: Record<string, number> }
      assert.equal(trained.army[type], 1)
    }

    for (const [type, name] of [
      ['goblinplunderer', 'Mystic Barracks'],
      ['clockworkbeetle', 'Mechanica Barracks']
    ] as const) {
      await assert.rejects(service.trainTroop(principal, {
        type, count: 1, requestId: `missing-${type}-runtime`
      }), error => error instanceof ApiError && error.status === 403 && error.message.includes(name))
    }

    await persistence.transaction(async tx => {
      const village = await tx.villages.get(principal.playerId, { forUpdate: true })
      assert(village)
      const expectedRevision = village.economyRevision
      village.army = Object.fromEntries([
        ['warrior', 1],
        ...REMOVED_TROOPS.map(type => [type, 1] as const)
      ])
      village.buildings = [
        ...village.buildings,
        { id: 'old-biopunk', type: 'biopunk_barracks', gridX: 0, gridY: 0, level: 9 }
      ]
      village.economyRevision = expectedRevision + 1
      assert.equal(await tx.villages.update(village, expectedRevision), true)
    })
    const cleaned = await service.getWorld(principal)
    assert.deepEqual(cleaned.army, { warrior: 1 })
    assert(!cleaned.buildings.some(building => String(building.type) === 'biopunk_barracks'))
  } finally {
    await service.close()
  }
})

test('normalized runtime materializes and persists known buildings at their current level cap', async () => {
  const persistence = new MemoryPersistence()
  let now = new Date('2026-07-18T14:00:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0
  })

  try {
    const session = grantedSession(await service.ensureSession('', 'level-cap-runtime'))
    const principal: RuntimePrincipal = { playerId: session.player.id }
    const injected = await persistence.transaction(async tx => {
      const village = await tx.villages.get(principal.playerId, { forUpdate: true })
      assert(village)
      const expectedRevision = village.economyRevision
      village.buildings = [
        ...village.buildings,
        {
          id: 'overlevel-barracks-runtime',
          type: 'barracks',
          gridX: 18,
          gridY: 3,
          level: 13,
          upgradingTo: 14,
          upgradeStartedAt: now.getTime(),
          upgradeEndsAt: now.getTime() + 60_000
        }
      ] as JsonValue[]
      village.economyRevision = expectedRevision + 1
      assert.equal(await tx.villages.update(village, expectedRevision), true)
      return {
        economyRevision: village.economyRevision,
        layoutRevision: village.layoutRevision,
        appearanceRevision: village.appearanceRevision
      }
    })

    now = new Date(now.getTime() + 1_000)
    const world = await service.getWorld(principal)
    const migrated = world.buildings.find(building => building.type === 'barracks')
    assert(migrated)
    assert.equal(migrated.level, 9)
    assert.equal(migrated.upgradingTo, undefined)
    assert.equal(migrated.upgradeStartedAt, undefined)
    assert.equal(migrated.upgradeEndsAt, undefined)

    await persistence.transaction(async tx => {
      const persisted = await tx.villages.get(principal.playerId)
      assert(persisted)
      const barracks = (persisted.buildings as Array<Record<string, unknown>>)
        .find(building => building.type === 'barracks')
      assert(barracks)
      assert.equal(barracks.level, 9)
      assert.equal(barracks.upgradingTo, undefined)
      assert.equal(barracks.upgradeStartedAt, undefined)
      assert.equal(barracks.upgradeEndsAt, undefined)
      assert.equal(persisted.economyRevision, injected.economyRevision + 1)
      assert.equal(persisted.layoutRevision, injected.layoutRevision + 1)
      assert.equal(persisted.appearanceRevision, injected.appearanceRevision + 1)
      assert.equal(persisted.lastMutationAt.getTime(), now.getTime())
    })
  } finally {
    await service.close()
  }
})

test('normalized army batch is mixed, atomic, idempotent, and returns its authoritative world', async () => {
  const persistence = new MemoryPersistence()
  const now = new Date('2026-07-18T15:00:00.000Z')
  const service = new PersistenceGameService(persistence, {
    now: () => new Date(now),
    starterShieldMs: 0,
    infiniteResources: false
  })
  try {
    const session = grantedSession(await service.ensureSession('', 'army-batch-runtime'))
    const principal: RuntimePrincipal = { playerId: session.player.id }
    const initialRevision = session.world.revision ?? 0
    const result = await service.armyBatch(principal, {
      operations: [
        { kind: 'train', type: 'warrior', count: 3 },
        { kind: 'untrain', type: 'warrior', count: 1 }
      ],
      requestId: 'mixed-runtime-batch'
    }) as {
      army: Record<string, number>
      gold: number
      food: number
      revision: number
      world: { army?: Record<string, number>; resources: { gold: number; food?: number }; revision?: number }
    }
    assert.equal(result.army.warrior, 2)
    assert.equal(result.gold, session.world.resources.gold - TROOP_DEFINITIONS.warrior.cost * 2)
    assert.equal(result.food, (session.world.resources.food ?? 0) - 4)
    assert.equal(result.revision, initialRevision + 1, 'the complete burst advances authority once')
    assert.deepEqual(result.world.army, result.army)
    assert.equal(result.world.resources.gold, result.gold)
    assert.equal(result.world.resources.food, result.food)

    const replay = await service.armyBatch(principal, {
      operations: [{ kind: 'train', type: 'warrior', count: 50 }],
      requestId: 'mixed-runtime-batch'
    })
    assert.deepEqual(replay, result, 'the request id replays the exact committed response')

    const beforeRejected = await service.getWorld(principal)
    await assert.rejects(service.armyBatch(principal, {
      operations: [
        { kind: 'train', type: 'warrior', count: 1 },
        { kind: 'untrain', type: 'warrior', count: 50 }
      ],
      requestId: 'rejected-runtime-batch'
    }), error => error instanceof ApiError && error.status === 409)
    const afterRejected = await service.getWorld(principal)
    assert.deepEqual(afterRejected.army, beforeRejected.army)
    assert.deepEqual(afterRejected.resources, beforeRejected.resources)
    assert.equal(afterRejected.revision, beforeRejected.revision, 'a rejected suffix commits no prefix')
  } finally {
    await service.close()
  }
})

test('legacy runtime enforces Army Camp core unlocks and both Barracks paths', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-two-path-training-'))
  let game: GameService | undefined
  try {
    game = new GameService(dataRoot)
    const session = grantedSession(game.ensureSession(undefined, 'two-path-legacy'))
    const player = game.authenticate(session.token)
    player.balance = 100_000
    player.food = 10_000

    assert.equal(game.trainTroop(player, {
      type: 'warrior', count: 1, requestId: 'camp-l1-barbarian-legacy'
    }).army.warrior, 1)
    assert.throws(() => game?.trainTroop(player, {
      type: 'archer', count: 1, requestId: 'camp-l1-archer-legacy'
    }), error => error instanceof ApiError && error.status === 403 && /level 2 Army Camp/.test(error.message))

    player.buildings = player.buildings.map(building => (
      building.type === 'army_camp'
        ? { ...building, upgradingTo: 2, upgradeEndsAt: Date.now() + 60_000 }
        : building
    ))
    assert.throws(() => game?.trainTroop(player, {
      type: 'warrior', count: 1, requestId: 'offline-camp-legacy'
    }), error => error instanceof ApiError && error.status === 403 && /level 1 Army Camp/.test(error.message))

    player.buildings = player.buildings
      .filter(building => !BARRACKS_TYPES.has(building.type))
      .map(building => building.type === 'army_camp'
        ? { ...building, level: 4, upgradingTo: undefined, upgradeEndsAt: undefined }
        : building)
    for (const type of ['archer', 'physicianscart', 'phalanx'] as const) {
      assert.equal(game.trainTroop(player, {
        type, count: 1, requestId: `camp-l4-${type}-legacy`
      }).army[type], 1)
    }
    for (const [type, name] of [
      ['goblinplunderer', 'Mystic Barracks'],
      ['clockworkbeetle', 'Mechanica Barracks']
    ] as const) {
      assert.throws(() => game?.trainTroop(player, {
        type, count: 1, requestId: `missing-${type}-legacy`
      }), error => error instanceof ApiError && error.status === 403 && error.message.includes(name))
    }
  } finally {
    game?.flush()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('legacy army batch commits mixed orders once and rolls back a rejected suffix', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-army-batch-legacy-'))
  let game: GameService | undefined
  try {
    game = new GameService(dataRoot)
    const session = grantedSession(game.ensureSession(undefined, 'army-batch-legacy'))
    const player = game.authenticate(session.token)
    const initialRevision = player.revision
    const initialGold = Math.floor(player.balance)
    const initialFood = player.food
    const result = game.armyBatch(player, {
      operations: [
        { kind: 'train', type: 'warrior', count: 3 },
        { kind: 'untrain', type: 'warrior', count: 1 }
      ],
      requestId: 'mixed-legacy-batch'
    })
    assert.equal(result.army.warrior, 2)
    assert.equal(result.gold, initialGold - TROOP_DEFINITIONS.warrior.cost * 2)
    assert.equal(result.food, initialFood - 4)
    assert.equal(result.revision, initialRevision + 1)
    assert.deepEqual(result.world.army, result.army)

    const replay = game.armyBatch(player, {
      operations: [{ kind: 'train', type: 'warrior', count: 50 }],
      requestId: 'mixed-legacy-batch'
    })
    assert.equal(replay.revision, result.revision)
    assert.deepEqual(replay.army, result.army)

    const beforeRejected = game.getWorld(player)
    assert.throws(() => game?.armyBatch(player, {
      operations: [
        { kind: 'train', type: 'warrior', count: 1 },
        { kind: 'untrain', type: 'warrior', count: 50 }
      ],
      requestId: 'rejected-legacy-batch'
    }), error => error instanceof ApiError && error.status === 409)
    const afterRejected = game.getWorld(player)
    assert.deepEqual(afterRejected.army, beforeRejected.army)
    assert.deepEqual(afterRejected.resources, beforeRejected.resources)
    assert.equal(afterRejected.revision, beforeRejected.revision)
  } finally {
    game?.flush()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('legacy runtime hydrates and persists known buildings at their current level cap', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'clash-level-cap-legacy-'))
  let active: GameService | undefined
  try {
    const writer = new GameService(dataRoot)
    active = writer
    const session = grantedSession(writer.ensureSession(undefined, 'level-cap-legacy'))
    const player = writer.authenticate(session.token)
    const injected = {
      revision: player.revision,
      layoutRevision: player.layoutRevision ?? player.revision,
      appearanceRevision: player.appearanceRevision ?? player.revision
    }
    player.buildings = [
      ...player.buildings,
      {
        id: 'overlevel-barracks-legacy',
        type: 'barracks',
        gridX: 18,
        gridY: 3,
        level: 13,
        upgradingTo: 14,
        upgradeStartedAt: Date.now(),
        upgradeEndsAt: Date.now() + 60_000
      }
    ]
    assert.equal(writer.flush(), true)
    active = undefined

    const migrator = new GameService(dataRoot)
    active = migrator
    const migrated = migrator.authenticate(session.token)
    const barracks = migrated.buildings.find(building => building.type === 'barracks')
    assert(barracks)
    assert.equal(barracks.level, 9)
    assert.equal(barracks.upgradingTo, undefined)
    assert.equal(barracks.upgradeStartedAt, undefined)
    assert.equal(barracks.upgradeEndsAt, undefined)
    assert.equal(migrated.revision, injected.revision + 1)
    assert.equal(migrated.layoutRevision, injected.layoutRevision + 1)
    assert.equal(migrated.appearanceRevision, injected.appearanceRevision + 1)
    assert.equal(migrator.flush(), true)
    const persistedRevisions = {
      revision: migrated.revision,
      layoutRevision: migrated.layoutRevision,
      appearanceRevision: migrated.appearanceRevision
    }
    active = undefined

    const reader = new GameService(dataRoot)
    active = reader
    const persisted = reader.authenticate(session.token)
    const persistedBarracks = persisted.buildings.find(building => building.type === 'barracks')
    assert(persistedBarracks)
    assert.equal(persistedBarracks.level, 9)
    assert.equal(persistedBarracks.upgradingTo, undefined)
    assert.deepEqual({
      revision: persisted.revision,
      layoutRevision: persisted.layoutRevision,
      appearanceRevision: persisted.appearanceRevision
    }, persistedRevisions)
  } finally {
    active?.flush()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
