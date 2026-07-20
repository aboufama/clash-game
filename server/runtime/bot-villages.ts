import type { SerializedWorld } from '../../src/game/data/Models'
import {
  PROCEDURAL_VILLAGE_GENERATOR_VERSION,
  generateProceduralVillage,
  proceduralVillageDifficulty,
  proceduralVillageTrophies
} from '../domain/world/procedural-village'
import { persistentBotVillageIdAt } from '../domain/world/bot-village-identity'
import {
  PersistenceConflictError,
  type BotVillageRecord,
  type UnitOfWork
} from '../persistence'

export interface PersistedBotVillageInput {
  worldId: string
  worldGenerationVersion: number
  /** Durable lower bound advanced whenever persisted bots are purged. */
  revisionEpoch: number
  x: number
  y: number
  seed: number
  now: Date
}

function assertProvenance(record: BotVillageRecord, input: PersistedBotVillageInput): void {
  if (record.worldId !== input.worldId || record.x !== input.x || record.y !== input.y) {
    throw new PersistenceConflictError('Persisted bot village coordinate does not match its lookup')
  }
  if (record.id !== persistentBotVillageIdAt(input.worldId, input.x, input.y)) {
    throw new PersistenceConflictError('Persisted bot village identity does not match its coordinate')
  }
  if (record.seed !== input.seed) {
    throw new PersistenceConflictError(
      'Persisted bot village provenance differs; explicitly reseed/migrate instead of regenerating it'
    )
  }
}

/**
 * The sole production generation boundary. A draft is inserted in the same
 * transaction before any caller can return or create an attack from it.
 */
export async function ensurePersistedBotVillage(
  tx: UnitOfWork,
  input: PersistedBotVillageInput
): Promise<BotVillageRecord> {
  const stored = await tx.world.getBotVillageAt(input.worldId, input.x, input.y)
  if (stored) {
    assertProvenance(stored, input)
    // Generator upgrades must reach already-persisted camps: provenance pins
    // WHERE/WHO, never the layout revision, so a record baked by an older
    // generator would otherwise serve its stale layout forever. Live attacks
    // hold immutable snapshots of the old layout, so an in-place regenerate
    // is safe; the CAS guards concurrent regenerators.
    if (stored.generatorVersion !== PROCEDURAL_VILLAGE_GENERATOR_VERSION) {
      const difficulty = proceduralVillageDifficulty(input.seed)
      const world = generateProceduralVillage(input.seed, { id: stored.id, ownerId: stored.id, difficulty })
      world.revision = stored.revision + 1
      world.lastSaveTime = 0
      const upgraded: BotVillageRecord = {
        ...stored,
        world,
        generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION,
        username: world.username ?? stored.username,
        trophies: proceduralVillageTrophies(input.seed),
        profile: {
          difficulty,
          generator: 'procedural-village',
          generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION
        },
        revision: stored.revision + 1,
        updatedAt: input.now
      }
      if (await tx.world.updateBotVillage(upgraded, stored.revision)) return upgraded
      // Lost the CAS to a concurrent regenerate — re-read and serve theirs.
      const winner = await tx.world.getBotVillageAt(input.worldId, input.x, input.y)
      if (winner) { assertProvenance(winner, input); return winner }
    }
    return stored
  }

  const id = persistentBotVillageIdAt(input.worldId, input.x, input.y)
  if (!Number.isSafeInteger(input.revisionEpoch) || input.revisionEpoch < 1) {
    throw new PersistenceConflictError('Bot village revision epoch must be a positive safe integer')
  }
  const difficulty = proceduralVillageDifficulty(input.seed)
  const world = generateProceduralVillage(input.seed, { id, ownerId: id, difficulty })
  world.revision = input.revisionEpoch
  // The first persisted payload must be identical across concurrent servers;
  // actual provisioning time lives on the record, not inside generated data.
  world.lastSaveTime = 0
  const record: BotVillageRecord = {
    id,
    worldId: input.worldId,
    x: input.x,
    y: input.y,
    plotVersion: 1,
    worldGenerationVersion: input.worldGenerationVersion,
    generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION,
    seed: input.seed,
    username: world.username ?? `Clan ${input.seed.toString(16).toUpperCase()}`,
    trophies: proceduralVillageTrophies(input.seed),
    profile: {
      difficulty,
      generator: 'procedural-village',
      generatorVersion: PROCEDURAL_VILLAGE_GENERATOR_VERSION
    },
    world,
    revision: input.revisionEpoch,
    createdAt: input.now,
    updatedAt: input.now
  }
  const result = await tx.world.insertBotVillage(record)
  if (result === 'inserted') return record

  // A concurrent provisioner won. Its committed timestamps are authoritative;
  // provenance and generated content were checked by the repository conflict.
  const concurrent = await tx.world.getBotVillageAt(input.worldId, input.x, input.y)
  if (!concurrent) throw new PersistenceConflictError('Bot village insert won without a readable persisted row')
  assertProvenance(concurrent, input)
  return concurrent
}

/** Public presentation projection: economy/army fields never leak into map windows. */
export function publicBotWorldOf(record: BotVillageRecord) {
  const world = record.world
  return {
    id: record.id,
    ownerId: record.id,
    username: record.username,
    buildings: world.buildings.map(building => ({ ...building })),
    obstacles: (world.obstacles ?? []).map(obstacle => ({ ...obstacle })),
    wallLevel: world.wallLevel,
    lastSaveTime: world.lastSaveTime,
    revision: record.revision,
    ...(world.population ? { population: structuredClone(world.population) } : {}),
    ...(world.life ? { life: structuredClone(world.life) } : {}),
    ...(world.banner ? { banner: { ...world.banner } } : {})
  }
}

export function botWorldForAttack(record: BotVillageRecord): SerializedWorld {
  return structuredClone(record.world)
}
