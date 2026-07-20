# server/ — the authoritative game server

The server owns everything that must not be client-trusted. The client owns the
base **layout shape** and all presentation; it sends the server a complete
proposed snapshot and the server decides what actually happened.

## Authority split (do not move server math to the client)
- **Client owns:** building layout/positions, all Phaser rendering, input.
- **Server owns:** balances, trophies, shields, plot allocation, the army,
  upgrades, population, and every attack's target / reservation / result /
  settlement / loot. Loot cap = `RAIDABLE_SHARE = 0.2` fixed at attack start.
- Never compute balance/army/trophy/loot/destruction on the client and persist
  it — the client only proposes a layout; the server prices it.

## Save model
`POST /api/world/save` sends the **full** layout. The server normalizes +
validates it, **prices the diff** (what changed since the last revision),
checks funds, charges, does `revision += 1`, and returns the authoritative
world. The army never rides a layout save: browser click bursts use atomic
`/army/batch`; `/army/train|untrain` remain compatibility endpoints.
`sanitizeBuildings` is fully data-driven — it drops unknown building types
(`if (!definition) continue`), which is the "old saves self-clean / deleting a
building type is safe" guarantee, and clamps to `maxCount`/`maxLevel`/footprint.

## Revision gating (concurrency)
Saves are idempotent with `expectedRevision` + `requestId`; a stale save gets a
409 and the client reconciles. On the client side every adoption of server
state must route through the revision-gated `adoptWorld` / `canAdoptAuthority`
path — a raw assignment lets a stale snapshot clobber a newer one.

## Layout of the code
- `http.ts` — pure `createApiHandler` dispatching over an `ApiService` contract.
- **Dual runtime** (`index.ts`): prod = Postgres `PersistenceGameService`
  (fails closed); dev/compat = legacy in-memory JSON `GameService` (`game.ts`).
  **A new endpoint must be added to `http.ts` AND both runtimes**, or it 404s in
  prod only.
- `store.ts` — in-memory Map, 150 ms-debounced **atomic tmp+fsync+rename**.
- `node-adapter.ts` — takes a single-writer **data-directory lease**
  (`.clash-server.lock`) and gates state-changing responses on a durable flush
  (returns 503 otherwise). Only one server per data dir — a second process on
  the same dir throws.
- `attack-domain/simulation.ts` — deterministic combat resolution (no wall
  clock, no RNG). Reads the same `getTroopStats` / `getBuildingStats` as the
  client. Changing authoritative combat math means bumping `simulationVersion`.
- Shared with the client: `src/game/config/*` + `data/Models` (compiled by
  `tsconfig.node.json`). **These must stay Phaser-free** — a Phaser import in
  `config/` breaks the server build.

## Mounting, running, testing
- **Dev:** `npm run dev` — Vite on `127.0.0.1:5173`; the server mounts as a Vite
  plugin (`server/vite-plugin.ts`) and 301-canonicalizes `localhost` → `127.0.0.1`
  (a token/localStorage origin trap — respect it). Dev sets
  `CLASH_ALLOW_DEBUG_GRANTS=1`, `CLASH_ALLOW_WORLD_RESEED=1`,
  `CLASH_INFINITE_RESOURCES=1`, and one-second upgrade timers. Infinite
  resources are a virtual server-side wallet: saved balances stay finite while
  player resource costs are waived.
- **Prod:** `npm run build` → esbuild `server/index.ts` → `dist-server/index.mjs`;
  `npm start` serves `dist/` + API standalone (default port 8787).
- **Tests:** `npm run test:server` (HTTP integration), `test:persistence`,
  `test:runtime`, `test:postgres` (PGlite); `npm run verify` chains them.

## Does the sprite-asset rework touch the server?
No. Assets are pure client presentation. The server stays byte-identical — it
already deals only in types, positions, levels, and numbers.
