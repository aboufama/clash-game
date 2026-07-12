# Village domain

The village domain is deliberately independent of HTTP and persistence:

- `layout.ts` normalizes untrusted payloads and enforces footprint, obstacle,
  wall-cohort, shop-limit, and occupied-army invariants.
- `economy.ts` prices a layout diff and materializes build/upgrade clocks
  without mutating either input snapshot.
- `simulation.ts` advances production, population, and timed upgrades from an
  explicit checkpoint.
- `rules.ts` defines semantic failures that the application layer maps to its
  transport-specific errors.

Together these functions form the deterministic boundary between an incoming
village command and the persistence/ledger mutations performed by
`GameService`.

