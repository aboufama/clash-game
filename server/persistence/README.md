# Transactional persistence and cutover boundary

This directory is the normalized database boundary for the game server. It
intentionally does not import client rendering or Phaser types.

## Runtime choices

- PostgreSQL is the production multi-process authority. `server/index.ts`
  detects `DATABASE_URL` (or `CLASH_STORAGE_MODE=postgres`), applies migrations,
  and constructs `PostgresPersistence`, `PersistenceGameService`, and the
  normalized attack service. A requested database runtime fails closed; it
  never falls through to a JSON writer.
- The synchronous JSON-backed `GameService` is an explicit local/cutover
  compatibility runtime. Select it with `CLASH_STORAGE_MODE=legacy-json` or a
  dedicated `CLASH_DATA_DIR`. Its data-directory lease permits one writer.
- `MemoryPersistence` is a copy-on-write, serialized transaction implementation
  for hermetic unit tests and local domain tools. It is not a production store.
- Redis may later hold disposable presence, rate-limit, and routing data; it must
  not hold balances, village authority, attack results, or settlement state.

The PostgreSQL schema enforces username, session, world-plot, outgoing-attack,
engaged defender-lease, command sequence/id, and settlement uniqueness. Business
changes and their outbox events are written in the same transaction. Bot,
scenario, and player targets use one attack aggregate; only player targets have
defender rows.

## Attack aggregate authority

Migration 6 closes the split between the state machine and its normalized row.
`attacks.authority` stores the complete schema-v1 `AttackAggregate`; phase,
version, deadline, snapshot, reservation, result, target, and participant
columns are checked relational projections used for indexes and bounded reads.
A null aggregate is permitted only for terminal history imported from before
aggregate authority existed. Those rows remain replayable but cannot resume.

Lifecycle changes use `attacks.compareAndSwapAuthority(...)`. The repository
locks and compares the current phase/version, rejects immutable metadata or
event-history rewrites, advances exactly one aggregate version, and refreshes
every projection in one update. Command handling uses
`commitAuthorityCommand(...)`, which writes the unique sequence/command-id audit
row and resulting aggregate as one operation. A stale CAS or mismatched retry
throws and rolls the surrounding transaction back. `appendCommand` exists only
for the frozen importer and audit tooling.

`listCommands` is sequence-ordered and capped. Replay chunks remain a separate,
participant-authorized projection, so command auditing does not weaken
`replays.listForParticipant`. Settlement, participant balance changes, ledgers,
notifications, and outbox events must share the same
`Persistence.transaction` as the final aggregate CAS.

`server/runtime/service.ts` composes asynchronous economy/world use cases;
`server/runtime/auth-service.ts` owns credentials, sessions, registration, and
guest-lease lifecycle; `server/runtime/village-authority.ts` centralizes stable
player lock order, revision updates, lazy materialization, and production-ledger
auditing. `server/runtime/attack-service.ts` owns combat use cases. The shared
async route table in `server/http.ts` accepts either these services or the
synchronous compatibility adapter. Production player traffic therefore reads
and writes the canonical tables below; the JSON lease remains only for
compatibility and the frozen source workflow.

## Expandable world authority

Migration 3 replaces a fixed coordinate scan with three durable indexes:

- `world_allocation_state` is the per-world monotonic high-water cursor. Lock it
  with `getAllocation(worldId, { forUpdate: true })` only for automatic
  allocation. Release and explicit-coordinate claims do not mutate the cursor.
  Its revision is checked on write, and schema/region size cannot change
  accidentally.
- `world_released_slots` stores reusable ordinals ordered by ordinal, with the
  plot version already advanced for the next occupant. Read small locked pages
  with `getReleasedSlots(..., { forUpdate: true })`; a full page is exhausted
  before frontier probing, while explicit exclusions stay in the index.
- `world_regions` pins each region to one generation version forever. Call
  `ensureRegion` before inserting a claim. Repeating identical metadata is safe;
  trying to reinterpret a coordinate with another generation conflicts.

`world_plots` references its pinned region and uses a version as a fencing token.
A permanent claim has all lease fields null. A guest claim has `lease_id`, issue,
renewal, and expiry together; the database rejects partial or inconsistent
leases. Renewal and promotion both require the current lease ID and refuse an
expired lease. Cleanup workers call `claimExpiredGuestAccountIds` inside a
transaction. PostgreSQL locks account roots in stable ID order with `FOR UPDATE
OF owner SKIP LOCKED`, then the runtime locks and rechecks each plot. This keeps
the canonical account-to-plot order across cleanup and player traffic.

An automatic allocation transaction therefore locks allocation/free-slot rows,
invokes the pure world allocator, ensures its generation-pinned region, inserts
the claim, deletes consumed released rows, and advances the cursor. Every
repository `assign` also consumes the claim coordinate's released ordinal in
the same transaction, so a far release racing a frontier scan cannot leave a
stale free row. A unique-claim conflict rolls the whole transaction back.
Release only deletes the locked claim and upserts the domain-produced ordinal
and next `plotVersion`; it never waits on the global cursor.

## Bounded read surfaces

Request handlers should use repository projections instead of loading a whole
collection and filtering in application memory:

- `accounts.listLeaderboard` walks the trophy index and always requires a
  top-N limit.
- `attacks.findCandidates` performs two limited, index-ordered trophy searches.
  It excludes the attacker, shielded/expired guests, rows without a village,
  other worlds, and defenders that already hold an engaged lease.
- `world.listAtlas` joins public player and village presentation state into one
  y/x window query, avoiding per-neighbour reads. Windows and result counts are
  both capped.
- `world.listPlayers` is the smaller plot/profile projection used by the
  strategic atlas; it never materializes 500 private villages.
- active incoming/outgoing attack lists, batched atlas attack edges,
  participant-authorized replay chunks, newest-first notification pages, and
  30-day economy summaries all require limits and stable cursors.

The shared caps and validation live in `query-bounds.ts`. Migration 5 adds the
matching ordered/partial indexes. These methods may clamp an oversized result
limit, but reject invalid cursors, trophy ranges, or atlas spans before SQL runs.

## Vercel release migrations

Vercel request handlers never run schema migrations. Apply migrations once,
before promoting a deployment, with the production `DATABASE_URL` explicitly
loaded into the release shell:

```sh
npm run db:migrate:release -- --confirm=APPLY_RELEASE_MIGRATIONS
npx vercel --prod
```

Do not put `db:migrate` in the Vercel build command: build workers are not a
release lock and multiple preview/production builds may overlap. The migration
CLI already uses a database advisory lock, checks every applied checksum, and
fails before deployment if production schema authority cannot be reached. The
release variant also preprovisions a bounded central bot pool so cloud bot
matching does not have to synthesize its first opponent on a player request.

Set `CRON_SECRET` in the production Vercel environment. `vercel.json` invokes
the authenticated `/api/internal/maintenance` job once daily (compatible with
Vercel Hobby as well as paid plans); ordinary player requests never execute
response-tail maintenance.

## Runtime maintenance and storage bounds

The authenticated scheduled maintenance job runs small bounded passes.
PostgreSQL uses `FOR UPDATE SKIP LOCKED`, so a delayed/overlapping invocation
cannot select the same rows:

- up to 50 expired guest plot leases are released per pass;
- up to 50 due attacks are expired or deterministically settled per pass;
- presentation-only replay chunks are pruned seven days after terminal
  settlement, at most ten attacks per pass, while the start snapshot, compact
  commands, settlement, and final authority remain durable.
- expired 24-hour transport idempotency keys and merchant redemption markers
  older than two days are deleted in separate expiry-ordered batches of at
  most 500 rows;
- notifications are maintained at an exact newest-50 cap per player. Writers
  serialize on that player's profile row, so concurrent API processes cannot
  leave 51 rows behind;
- outbox hints retain published rows for 24 hours and undelivered rows for a
  seven-day delivery window. Cleanup skips live worker leases. UI notifications
  and game authority are committed directly, so expiry never deletes gameplay
  state. **No external outbox publisher is bundled**; a deployment that adds an
  external sink must consume hints inside that documented window.

Replay presentation writes also charge an atomic 2 MiB/512-frame per-attack
budget in `replay_presentation_usage`; an attacker cannot grow storage by
sending large or duplicate visual frames.
Revenge rights expire after 48 hours and retain at most three uses per opponent
across the 32 latest-expiring opponents. Bot-raid cooldowns last 30 minutes and
retain at most the newest 128 coordinates; normalization drops expired or
malformed entries whenever the account is touched by attack flow.
Idempotency keys, attack command IDs/sequences, settlement receipts, balance
ledger effects, notifications, and outbox events all have database uniqueness
fences in the transaction that creates their business effect.

## Commands

```sh
npm run test:persistence
npm run test:postgres
npm run db:migrate
npm run db:materialize-legacy -- \
  --data=server/data \
  --output=/srv/clash-cutover-2026-07-12 \
  --cutoff=2026-07-12T00:00:00.000Z
npm run db:validate-legacy -- \
  --data=/srv/clash-cutover-2026-07-12 \
  --cutoff=2026-07-12T00:00:00.000Z
npm run db:import-legacy -- \
  --data=/srv/clash-cutover-2026-07-12 \
  --cutoff=2026-07-12T00:00:00.000Z
npm run db:verify-legacy -- \
  --data=/srv/clash-cutover-2026-07-12 \
  --cutoff=2026-07-12T00:00:00.000Z
```

`test:persistence` verifies repository contracts with the hermetic in-memory
implementation. `test:runtime` (from the repository root) covers the normalized
service through the shared HTTP route table. `test:postgres` applies every
migration and exercises PostgreSQL repositories, normalized core/attack
services, and the real Node HTTP adapter using embedded PGlite. This provides PostgreSQL query, constraint,
transaction, and JSONB semantics without a network server; it does not validate
socket behavior, connection-pool pressure, failover, or contention across live
hosts. Those remain deployment/staging checks.

Only migrate/import/verify require `DATABASE_URL`; materialization and validation
are filesystem-only. `--output` must name a new directory outside `--data`.
The publisher never edits, locks, or removes anything in the source directory.

## Cutover contract

1. Stop legacy writes and drain or abort every live PvP and bot attack.
2. Choose one fixed cutover timestamp. Do not call `Date.now()` independently
   for each player.
3. Run `materialize-legacy` against the stopped source. It refuses a live
   data-directory owner, a live/settling attack, future village checkpoints,
   an existing output, or an output nested under the source. Every committed
   JSON collection (including world allocation state) is copied; non-player
   records retain their exact bytes.
4. The materializer calls the versioned deterministic `advanceVillage` clock
   exactly once per player with the one cutoff. It preserves the legacy
   revision, initializes layout/appearance revisions, advances appearance once
   per deterministic upgrade/birth/departure event, and stamps `lastAccrualAt`,
   `simulatedThrough`, `simulationVersion`, and the next event checkpoint together.
5. The output is built in a sibling staging directory and published with one
   directory rename. Before publication the source inventory is read again;
   any added, removed, or changed record aborts the run. A failed run therefore
   exposes no partial snapshot and leaves the source untouched.
6. Preserve `cutover-manifest.json`. It records per-record source/output SHA-256,
   per-collection and aggregate checksums, resource/population totals, and all
   deterministic simulation deltas. Repeating a run from identical input and
   cutoff produces the same snapshot checksum.
7. Run `validate-legacy` on the frozen output with the same cutoff. A missing or
   tampered manifest, any non-exact player checkpoint, or a mismatched simulation
   version is an import-blocking error.
8. Run migrations and import into an empty database. Import is one transaction,
   so a failure cannot leave a partially migrated world.
9. The importer creates generation-1 regions and preserves the frozen world's
   allocation frontier, released-slot indexes/versions, and occupied plot
   fencing versions. Snapshots from before `world-state` existed get one bounded
   high-water/hole reconstruction; that scan is never repeated at runtime.
10. If a frozen replay or bot raid already carries a valid schema-v1 attack
   aggregate, the importer preserves it and reconstructs its normalized command
   audit rows. Older terminal records remain explicitly non-resumable.
11. The importer verifies source checksums, canonical row counts (including
   command rows), and aggregate
   gold/ore/food/trophy totals before the database is used by the server. It
   also compares every `villages.appearance_revision` to the frozen player so
   neighbour postcard and villager-population caches cannot regress at cutover.

Every original JSON record is retained in `legacy_import_manifest` with its
checksum for audit/rollback. The importer, verifier, and live PostgreSQL runtime
use canonical tables, not those raw records. Keep the frozen directory and
manifest until the operational rollback window has closed; never point a live
JSON writer at that sealed source.
