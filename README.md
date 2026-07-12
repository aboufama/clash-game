# Clash Prototype

An isometric shared-world base builder: React owns the UI, Phaser renders the
world, and a Node server owns accounts, villages, the economy, world plots,
attacks, and replays. Building and troop art is authored as hand-drawn vector
code and baked into committed pixel-art sprite sheets that the game renders
from (see [`docs/AGENTS_SPRITE_PIPELINE.md`](docs/AGENTS_SPRITE_PIPELINE.md)).

## Local development

Requirements: Node.js 20–24.

```bash
npm install
npm run dev:game
```

Vite mounts the explicitly single-writer JSON compatibility server for a
zero-setup local world in `server/data/`. A browser receives a guest village on
first visit; registering a username and password makes it loadable from other
devices.

## Production

Production authority is normalized PostgreSQL. Startup applies ordered
migrations under an advisory lock and fails closed if the database cannot be
reached—it never falls back to JSON.

```bash
npm run build
DATABASE_URL=postgres://user:pass@host:5432/clash npm start
```

`CLASH_STORAGE_MODE=postgres` may be set explicitly. The old JSON runtime is
available only for local compatibility and frozen cutover work:

```bash
CLASH_STORAGE_MODE=legacy-json CLASH_DATA_DIR=/srv/clash-json npm start
```

Do not run more than one JSON writer. PostgreSQL supports multiple API
processes; revisions, unique leases, compare-and-swap attack state, and
serializable settlement transactions provide the concurrency fences.

The repository includes embedded PostgreSQL coverage for migrations,
constraints, JSONB behavior, indexed queries, and normalized service flows.
That test does not reproduce network faults, pool exhaustion, failover, or
live contention across multiple hosts; validate those against the deployed
PostgreSQL service before scaling out.

For an existing JSON world, follow the sealed materialize → validate → import
→ verify runbook in [`server/persistence/README.md`](server/persistence/README.md).

## Authority model

- **Accounts and world plots** — opaque device sessions, registered logins,
  bounded session counts, versioned plot claims, guest leases, and shields are
  server-owned.
- **Villages** — clients propose a complete layout at an expected revision;
  the server normalizes, validates, prices, and atomically applies the diff.
  Gold, ore, food, upgrades, population, and armies never trust client totals.
- **Mass simulation** — villages advance lazily between deterministic event
  boundaries. Offline players consume no background tick. Public snapshots
  carry exact buildings and resident manifests; clients derive identical
  motion from stable identity and server-corrected wall time.
- **World rendering** — nearby player villages use full-resolution postcards
  (vector-drawn, quantized once to the 1.35-px bake texel grid), including
  grass, stone paths, and full villager art. Only GPU residency is reduced
  offscreen; player art is never further downsampled.
- **Attacks** — neighbor, direct, matchmade, revenge, and bot targets all enter
  one `AttackAggregate`. The first deploy revalidates the exact map plot and
  obtains the defender lease. Sequenced commands drive deterministic server
  simulation; client destruction and loot counters are presentation only.
- **Settlement** — both participants, army release/consumption, trophies,
  balances, receipt, replay, ledger, notification, and outbox event commit in
  one transaction.

Outbox rows are bounded transactional integration hints. No external outbox
publisher is bundled; UI notifications and gameplay authority are stored
directly, while deployments that need an external sink must supply a publisher
within the documented delivery window.

Every rewarding attack is presented at its canonical world coordinate through
the same local battlefield swap. Practice and replay viewing are explicitly
non-rewarding presentation modes.

## Verification

```bash
npm run test:server
npm run test:persistence
npm run test:runtime
npm run test:postgres
node scripts/run-attack-domain-regression.mjs
npm run test:defenses
npm run test:building-visuals
npm run test:client-attacks
npm run test:pathing
npm run test:world-postcards
npm run build
```

`test:runtime` covers normalized services through the shared HTTP route table
using hermetic persistence. `test:postgres` separately covers migrations,
repositories, normalized core/attack service flows, and the real Node HTTP
adapter with embedded PGlite PostgreSQL semantics; it is not a networked
database or connection-pool load test. Run
`npm run verify` for the composite chain. Live multi-host database contention
remains an operational staging boundary.

Before changing building art, read
[`docs/BUILDING_ART_GUIDE.md`](docs/BUILDING_ART_GUIDE.md) and verify screenshots
with `tools/art-preview/`; typechecking cannot validate isometric layering.

The documentation entry point is [`docs/README.md`](docs/README.md).
