import { VILLAGE_SIMULATION_VERSION } from '../domain/village'
import { ApiError } from '../errors'
import type {
  AccountRecord,
  UnitOfWork,
  VillageRecord,
  WorldPlotRecord
} from '../persistence'
import { materializeVillage } from './village-state'

const PRESENCE_WRITE_INTERVAL_MS = 30_000

export const ACTIVE_INCOMING_STATES = new Set(['engaged', 'active', 'finalizing'])

export interface OwnedState {
  account: AccountRecord
  village: VillageRecord
  plot: WorldPlotRecord
}

/** Client-relevant village authority, intentionally excluding clock checkpoints. */
export function villageMaterialFingerprint(village: VillageRecord): string {
  return JSON.stringify({
    buildings: village.buildings,
    obstacles: village.obstacles,
    army: village.army,
    wallLevel: village.wallLevel,
    gold: village.gold,
    ore: village.ore,
    food: village.food,
    productionRemainders: village.productionRemainders,
    population: village.population,
    layoutRevision: village.layoutRevision,
    appearanceRevision: village.appearanceRevision,
    simulationVersion: village.simulationVersion
  })
}

/**
 * Shared transaction boundary for player-owned authority.
 *
 * Keeping lock order and simulation auditing here prevents auth, economy, and
 * world use cases from slowly developing incompatible persistence semantics.
 */
export class VillageAuthority {
  async owned(tx: UnitOfWork, playerId: string, forUpdate = false): Promise<OwnedState> {
    // One lock order everywhere prevents account/village/plot deadlocks when
    // several server processes mutate the same player concurrently.
    const account = await tx.accounts.getById(playerId, { forUpdate })
    const village = await tx.villages.get(playerId, { forUpdate })
    const plot = await tx.world.getPlayerPlot(playerId, { forUpdate })
    if (!account || !village || !plot) throw new ApiError(401, 'Player authority is incomplete')
    return { account, village, plot }
  }

  async updateAccount(tx: UnitOfWork, account: AccountRecord, expected: number): Promise<void> {
    account.revision = expected + 1
    if (!await tx.accounts.update(account, expected)) {
      throw new ApiError(409, 'Player profile changed; retry the request', 'PLAYER_REVISION_CONFLICT')
    }
  }

  async updateVillage(tx: UnitOfWork, village: VillageRecord, expected: number): Promise<void> {
    village.economyRevision = expected + 1
    if (!await tx.villages.update(village, expected)) {
      throw new ApiError(409, 'Village changed; reload and retry', 'STALE_REVISION')
    }
  }

  async materializeOwned(
    tx: UnitOfWork,
    village: VillageRecord,
    now: Date,
    populationLocked = false
  ): Promise<void> {
    if (village.simulatedThrough.getTime() >= now.getTime()
      && village.simulationVersion === VILLAGE_SIMULATION_VERSION) return
    const expected = village.economyRevision
    const before = villageMaterialFingerprint(village)
    await this.materializeWithAudit(tx, village, now, populationLocked)
    if (villageMaterialFingerprint(village) !== before) await this.updateVillage(tx, village, expected)
  }

  async materializeWithAudit(
    tx: UnitOfWork,
    village: VillageRecord,
    now: Date,
    populationLocked = false
  ) {
    const before = { gold: village.gold, ore: village.ore, food: village.food }
    const result = materializeVillage(village, now, { populationLocked })
    const auditId = `sim:${result.from}:${result.through}`
    for (const currency of ['gold', 'ore', 'food'] as const) {
      const delta = village[currency] - before[currency]
      if (delta === 0) continue
      await tx.balanceLedger.append({
        playerId: village.playerId,
        operation: 'village.simulation',
        requestId: auditId,
        currency,
        delta,
        balanceAfter: village[currency],
        metadata: {
          simulationVersion: result.simulationVersion,
          from: result.from,
          through: result.through
        },
        createdAt: now
      })
    }
    return result
  }

  async touchPresence(tx: UnitOfWork, account: AccountRecord, now: Date): Promise<void> {
    const persisted = account.lastSeenAt
    account.lastSeenAt = now
    if (now.getTime() - persisted.getTime() >= PRESENCE_WRITE_INTERVAL_MS) {
      await tx.accounts.touchLastSeen(account.id, now)
    }
  }

  async hasActiveIncoming(tx: UnitOfWork, playerId: string): Promise<boolean> {
    return (await tx.attacks.listLeasedIncoming(playerId, 1)).length > 0
  }

  async hasActiveOutgoing(tx: UnitOfWork, playerId: string): Promise<boolean> {
    return (await tx.attacks.listActiveOutgoing(playerId, 1)).length > 0
  }

  async leasedIncomingForPlayers(tx: UnitOfWork, playerIds: readonly string[]) {
    if (playerIds.length === 0) return []
    // The database permits at most one leased incoming attack per defender,
    // so one capped batch can return every visible defender edge.
    return tx.attacks.listLeasedIncomingForDefenders(playerIds, playerIds.length)
  }
}
