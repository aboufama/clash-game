import { ApiError } from '../errors'
import type { UnitOfWork } from '../persistence'

/**
 * Cross-process mutation barrier shared by every normalized gameplay write.
 *
 * PostgreSQL takes a shared row lock here, so unrelated player transactions
 * remain concurrent. Maintenance/reset takes an update lock on the same row:
 * it drains work that already passed this fence, blocks later work, and keeps
 * the lock through the destructive reset transaction. MemoryPersistence is
 * transaction-serialized and therefore gets the same ordering semantics.
 */
export async function assertGameplayMutationAllowed(tx: UnitOfWork): Promise<void> {
  const config = await tx.admin.getConfig({ forShare: true })
  if (!config.maintenanceEnabled) return
  throw new ApiError(
    503,
    config.maintenanceMessage || 'The game is temporarily under maintenance',
    'MAINTENANCE'
  )
}

/** Serialize an allowed maintenance-time mutation (currently logout) with reset. */
export async function acquireMaintenanceMutationFence(tx: UnitOfWork): Promise<void> {
  await tx.admin.getConfig({ forShare: true })
}
