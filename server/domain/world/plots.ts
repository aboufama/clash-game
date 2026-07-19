import {
  assertPlotCoordinate,
  plotKey,
  regionIdOf,
  regionCoordinatesForPlot,
  type PlotCoordinate,
  type RegionAddress
} from './coordinates'
import { classifyPlot } from './generation'

export const INITIAL_PLOT_VERSION = 1
export const DEFAULT_GUEST_PLOT_TTL_MS = 7 * 24 * 60 * 60_000
export const MAX_GUEST_PLOT_TTL_MS = 30 * 24 * 60 * 60_000

export interface PermanentPlotLease {
  kind: 'PERMANENT'
}

export interface GuestPlotLease {
  kind: 'GUEST'
  leaseId: string
  issuedAt: number
  renewedAt: number
  expiresAt: number
}

export type PlotLease = PermanentPlotLease | GuestPlotLease

export interface PlotClaim {
  worldId: string
  coordinate: PlotCoordinate
  region: RegionAddress
  ownerId: string
  plotVersion: number
  assignedAt: number
  lease: PlotLease
}

export interface VersionedPlotReference {
  worldId: string
  x: number
  y: number
  regionId: string
  generationVersion: number
  plotVersion: number
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative epoch millisecond`)
}

function assertIdentifier(value: string, name: string): void {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.trim() !== value) {
    throw new RangeError(`${name} must be a non-empty, trimmed string of at most 256 characters`)
  }
}

export function assertPlotVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < INITIAL_PLOT_VERSION) {
    throw new RangeError('plotVersion must be a positive safe integer')
  }
}

export function nextPlotVersion(current: number): number {
  assertPlotVersion(current)
  if (current === Number.MAX_SAFE_INTEGER) throw new RangeError('plotVersion is exhausted')
  return current + 1
}

export function permanentPlotLease(): PermanentPlotLease {
  return { kind: 'PERMANENT' }
}

function validatedGuestTtl(ttlMs: number): number {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_GUEST_PLOT_TTL_MS) {
    throw new RangeError(`guest plot TTL must be from 1 to ${MAX_GUEST_PLOT_TTL_MS}ms`)
  }
  return ttlMs
}

function assertGuestPlotLease(lease: GuestPlotLease): void {
  assertIdentifier(lease.leaseId, 'leaseId')
  assertTimestamp(lease.issuedAt, 'lease issuedAt')
  assertTimestamp(lease.renewedAt, 'lease renewedAt')
  assertTimestamp(lease.expiresAt, 'lease expiresAt')
  if (lease.renewedAt < lease.issuedAt || lease.expiresAt <= lease.renewedAt) {
    throw new RangeError('guest lease timestamps are inconsistent')
  }
}

export function createGuestPlotLease(input: {
  leaseId: string
  now: number
  ttlMs?: number
}): GuestPlotLease {
  assertIdentifier(input.leaseId, 'leaseId')
  assertTimestamp(input.now, 'now')
  const ttl = validatedGuestTtl(input.ttlMs ?? DEFAULT_GUEST_PLOT_TTL_MS)
  const expiresAt = input.now + ttl
  assertTimestamp(expiresAt, 'lease expiresAt')
  return {
    kind: 'GUEST',
    leaseId: input.leaseId,
    issuedAt: input.now,
    renewedAt: input.now,
    expiresAt
  }
}

export function isGuestPlotLeaseExpired(lease: GuestPlotLease, now: number): boolean {
  assertGuestPlotLease(lease)
  assertTimestamp(now, 'now')
  return now >= lease.expiresAt
}

/** Extends an active lease from observed activity; expired leases cannot be resurrected. */
export function renewGuestPlotLease(
  lease: GuestPlotLease,
  input: { now: number; ttlMs?: number }
): GuestPlotLease {
  assertGuestPlotLease(lease)
  assertTimestamp(input.now, 'now')
  if (isGuestPlotLeaseExpired(lease, input.now)) throw new RangeError('expired guest plot lease cannot be renewed')
  const ttl = validatedGuestTtl(input.ttlMs ?? DEFAULT_GUEST_PLOT_TTL_MS)
  const proposedExpiry = input.now + ttl
  assertTimestamp(proposedExpiry, 'lease expiresAt')
  return {
    ...lease,
    renewedAt: Math.max(lease.renewedAt, input.now),
    expiresAt: Math.max(lease.expiresAt, proposedExpiry)
  }
}

export function plotLeaseExpiresAt(lease: PlotLease): number | null {
  return lease.kind === 'GUEST' ? lease.expiresAt : null
}

export function isPlotClaimExpired(claim: PlotClaim, now: number): boolean {
  return claim.lease.kind === 'GUEST' && isGuestPlotLeaseExpired(claim.lease, now)
}

export function renewGuestPlotClaim(
  claim: PlotClaim,
  input: { now: number; ttlMs?: number }
): PlotClaim {
  if (claim.lease.kind !== 'GUEST') throw new RangeError('permanent plot claim has no guest lease to renew')
  return { ...claim, lease: renewGuestPlotLease(claim.lease, input) }
}

/** Registration keeps the same coordinate and plotVersion; only the lease becomes permanent. */
export function promoteGuestPlotClaim(claim: PlotClaim, now: number): PlotClaim {
  if (claim.lease.kind !== 'GUEST') return claim
  if (isGuestPlotLeaseExpired(claim.lease, now)) throw new RangeError('expired guest plot claim cannot be promoted')
  return { ...claim, lease: permanentPlotLease() }
}

export function expiredGuestPlotClaims(claims: Iterable<PlotClaim>, now: number): PlotClaim[] {
  assertTimestamp(now, 'now')
  return [...claims].filter(claim => isPlotClaimExpired(claim, now))
}

export function createPlotClaim(input: {
  coordinate: PlotCoordinate
  region: RegionAddress
  ownerId: string
  plotVersion: number
  assignedAt: number
  lease: PlotLease
}): PlotClaim {
  assertPlotCoordinate(input.coordinate)
  assertIdentifier(input.ownerId, 'ownerId')
  assertPlotVersion(input.plotVersion)
  assertTimestamp(input.assignedAt, 'assignedAt')
  const expectedRegion = regionCoordinatesForPlot(input.coordinate, input.region.size)
  if (input.region.x !== expectedRegion.x || input.region.y !== expectedRegion.y) {
    throw new RangeError('plot coordinate does not belong to the supplied region')
  }
  const expectedRegionId = regionIdOf({
    worldId: input.region.worldId,
    generationVersion: input.region.generationVersion,
    coordinate: input.region,
    size: input.region.size
  })
  if (input.region.id !== expectedRegionId) throw new RangeError('region metadata does not match its region id')
  // Bot-classified land is claimable — the claim replaces the generated camp.
  // Only preserves (and their hydrology plots) reject player claims.
  if (classifyPlot(input.coordinate, input.region.generationVersion).kind === 'PRESERVE') {
    throw new RangeError('player plot claim is not eligible under its region generation')
  }
  if (input.lease.kind === 'GUEST') {
    assertGuestPlotLease(input.lease)
  }
  return {
    worldId: input.region.worldId,
    coordinate: { ...input.coordinate },
    region: { ...input.region },
    ownerId: input.ownerId,
    plotVersion: input.plotVersion,
    assignedAt: input.assignedAt,
    lease: { ...input.lease }
  }
}

export function plotReference(claim: PlotClaim): VersionedPlotReference {
  return {
    worldId: claim.worldId,
    x: claim.coordinate.x,
    y: claim.coordinate.y,
    regionId: claim.region.id,
    generationVersion: claim.region.generationVersion,
    plotVersion: claim.plotVersion
  }
}

export function matchesPlotReference(claim: PlotClaim, reference: VersionedPlotReference): boolean {
  return claim.worldId === reference.worldId
    && claim.coordinate.x === reference.x
    && claim.coordinate.y === reference.y
    && claim.region.id === reference.regionId
    && claim.region.generationVersion === reference.generationVersion
    && claim.plotVersion === reference.plotVersion
}

export function claimKey(claim: PlotClaim): string {
  return plotKey(claim.worldId, claim.coordinate)
}
