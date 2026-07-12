# World domain integration contract

This package is pure domain code. It does not mutate `GameService` or perform
database I/O.

The normalized PostgreSQL adapter persists every record described below. The
current JSON `GameService` compatibility adapter uses generation 1 and persists
the allocation high-water cursor/released slots in `world-state`, with claim,
plot-version, and guest-lease fields on player records. Do not mistake that
single-writer representation for the final region-table runtime.

Persist the following authority records:

- One allocation row per `worldId`: allocation schema, region size, current
  generation version, and `nextOrdinal`.
- Released slots keyed by `(worldId, ordinal)`, including the already advanced
  `plotVersion`.
- Regions keyed by `(worldId, regionX, regionY)`, with immutable `regionId`,
  `size`, and `generationVersion`.
- Plot claims with the region ID, numeric plot version, owner, assignment time,
  and nullable guest lease deadline.

Allocation must run in one serializable transaction:

1. Lock the world's allocation row and one small ordinal-ordered page of
   released slots. A full page spends that transition's whole probe budget and
   loops; only a short page proves the free index is exhausted and permits
   frontier allocation. Explicit exclusions are applied by the indexed query.
2. Resolve an existing region's pinned generation version.
3. Call `allocateNextPlayerPlot`; the occupancy callback reads claims in the
   same transaction.
4. Delete rejected `consumedReleasedOrdinals`, insert the region when first
   encountered, insert the unique plot claim, and persist the returned
   allocation index. Every repository assignment also deletes the exact
   coordinate ordinal, closing release-versus-frontier races.
5. A unique-claim conflict aborts the transaction so the consumed cursor/free
   slot is rolled back with it.

Release removes its already locked claim and upserts the advanced free-slot row;
it does not read, lock, or revise the unrelated high-water cursor. Guest cleanup
selects a bounded lease-deadline batch, locks account roots in stable ID order
with `SKIP LOCKED`, then locks/rechecks each plot before using that same release
transaction. This preserves the account-to-plot mutation order. Registration uses
`promoteGuestPlotClaim` and does not change the plot version.

Explicit-coordinate claims read allocation configuration without locking the
cursor, then lock released-slot before occupant, matching automatic allocation.
Only automatic admission/reallocation serializes on the per-world high-water
row. Durable block reservations are the next scaling step if that short
admission critical section becomes measurable; a process-local block cache is
not safe because crashes would strand ordinals.

Local map reads use `boundedLocalWindow`, query claims by coordinate bounds,
then classify unclaimed coordinates with the generation version pinned to each
intersecting region. Version 1 keeps all legacy absolute coordinates and
eligibility unchanged.

For the one-time legacy cutover, create generation-1 region rows around every
existing claim, set `nextOrdinal` to one beyond the greatest occupied ordinal,
and index eligible unoccupied ordinals below that cursor as free slots with
plot version 1. This is a bounded migration scan of the old world, not a scan
performed for each future allocation.
