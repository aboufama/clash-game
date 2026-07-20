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

export function assertPersistedBotVillageProvenance(
  record: BotVillageRecord,
  input: PersistedBotVillageInput
): void {
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
 * CPU-only deterministic preparation. Map callers run this outside their
 * database transaction, then persist every returned draft in one bounded
 * repository call. `null` means the durable record is already current.
 */
export function preparePersistedBotVillage(
  input: PersistedBotVillageInput,
  stored: BotVillageRecord | null
): BotVillageRecord | null {
  if (stored) {
    assertPersistedBotVillageProvenance(stored, input)
    if (stored.generatorVersion === PROCEDURAL_VILLAGE_GENERATOR_VERSION) return null
    if (stored.generatorVersion > PROCEDURAL_VILLAGE_GENERATOR_VERSION) return null
    const difficulty = proceduralVillageDifficulty(input.seed)
    const world = generateProceduralVillage(input.seed, { id: stored.id, ownerId: stored.id, difficulty })
    world.revision = stored.revision + 1
    world.lastSaveTime = 0
    return {
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
  }

  const id = persistentBotVillageIdAt(input.worldId, input.x, input.y)
  if (!Number.isSafeInteger(input.revisionEpoch) || input.revisionEpoch < 1) {
    throw new PersistenceConflictError('Bot village revision epoch must be a positive safe integer')
  }
  const difficulty = proceduralVillageDifficulty(input.seed)
  const world = generateProceduralVillage(input.seed, { id, ownerId: id, difficulty })
  world.revision = input.revisionEpoch
  world.lastSaveTime = 0
  return {
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
}

/** Single-record durability boundary used by attack start and admin flows. */
export async function ensurePersistedBotVillage(
  tx: UnitOfWork,
  input: PersistedBotVillageInput
): Promise<BotVillageRecord> {
  const stored = await tx.world.getBotVillageAt(input.worldId, input.x, input.y)
  const draft = preparePersistedBotVillage(input, stored)
  if (!draft) return stored!
  await tx.world.provisionBotVillages([draft])
  // A concurrent provisioner or generator upgrader may have won. Always serve
  // the committed row, never the locally prepared draft.
  const committed = await tx.world.getBotVillageAt(input.worldId, input.x, input.y)
  if (!committed) throw new PersistenceConflictError('Bot village provision completed without a durable row')
  assertPersistedBotVillageProvenance(committed, input)
  return committed
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
