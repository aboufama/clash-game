# Unified attack domain

This module is the transport- and persistence-independent authority for combat.
`server/runtime/attack-service.ts` is its production PostgreSQL adapter;
`server/game.ts` retains the same aggregate in the single-writer JSON
compatibility runtime. The aggregate also supports non-rewarding scenarios.

## One target contract

Target selection happens before combat. Neighbor, direct, matchmade, and
revenge players all become a `WorldAttackTarget` with `kind: 'PLAYER'` and an
exact world plot, plot occupancy version, village appearance/combat version,
and immutable snapshot hash. Bots use the same aggregate and commands with
`kind: 'BOT'`, pinned to a persisted bot ID, plot version, generator version,
village revision, and immutable snapshot hash; scenarios use `kind: 'SCENARIO'`.

Selection source is audit metadata. It never chooses a second combat
implementation.

## State machine

```text
PREPARING -> ENGAGED -> ACTIVE -> FINALIZING -> SETTLED
     |          |
     +-> CANCELLED <-+
     |          |
     +-> EXPIRED  <-+
```

- `prepareAttack` validates the immutable snapshot/rules/reward policy and
  records an army reservation grant.
- The first real deploy engages the target. PLAYER engagement rechecks target
  identity, plot version, village version, shield, and an exclusive defender
  lease. BOT engagement retains its immutable persisted target snapshot.
- `applyAttackCommand` accepts contiguous, idempotent deploy/ability/surrender
  commands with phase/version compare-and-swap semantics.
- `finalizeAttack` regenerates the result from snapshot, seed, rules version,
  and the compact event log. The client never supplies authoritative
  destruction or loot totals.
- `settleAttack` accepts one durable transaction receipt and is idempotent when
  that exact receipt is replayed.

`POST /api/attacks/commands` accepts exactly one command per request so an
invalid later batch item cannot leave a partially successful request. Both
player and bot raids dispatch through it.

## Persistence transaction contract

The normalized production adapter enforces these boundaries:

1. **Prepare:** reserve the army and insert the `PREPARING` aggregate in one
   account transaction.
2. **Engage:** atomically validate plot/village/shield state, acquire the
   defender lease, and CAS the aggregate.
3. **Command:** load the aggregate, apply one command, and CAS the new
   phase/version. A duplicate command ID with the identical canonical payload
   returns its original receipt; reuse or a sequence gap is rejected.
4. **Finalize:** deterministically build the result and settlement plan.
5. **Settle:** commit participant deltas, reservation consumption/release,
   receipt, aggregate, and outbox events in one transaction.

The normalized repository stores the full JSON-safe aggregate in
`attacks.authority`; relational attack columns are checked query projections,
not a second source of truth. Non-command transitions use
`compareAndSwapAuthority`. Accepted commands use `commitAuthorityCommand`,
which persists the command audit row and resulting aggregate atomically. Only
terminal pre-aggregate imports may have null authority, and they cannot resume.

The compatibility `GameService` persists the aggregate inside its replay or
bot-raid record and uses a write-ahead settlement journal plus participant
idempotency markers. Production instead uses serializable repository
transactions, stable participant lock ordering, aggregate CAS, unique outgoing
and defender leases, and bounded `SKIP LOCKED` expiry workers.

## Simulation and replays

`ATTACK_SIMULATION_VERSION` pins result behavior. Stored version-1 attacks keep
their legacy destroyed-building-count branch; version 2 uses HP-weighted
partial structural damage. Version 7 only grants Siege Tower pathing credit
when the frozen base has a cardinally-connected closed wall loop; versions
4–6 retain the prior unconditional credit. Version 8 checks each tower's
recorded deploy-to-nearest-Town-Hall ray and grants credit only when that ray
meets a wall. Version 9 adds bounded persistent Spike Launcher hazard credit
and makes declarative suicide troops one-shot in settlement; stored v1-v8
attacks keep their prior branches. New behavior must get a new version rather
than silently changing old replays.

`compactReplay` contains immutable snapshot identity plus sequenced deploy,
ability, and lifecycle events. Any process with the matching simulation
version can rebuild the same result hash.

Presentation frames remain for live spectating and interpolation. They have an
atomic 2 MiB/512-frame per-attack cap and are pruned seven days after terminal
settlement; oversized visual data is dropped without affecting combat. Compact
commands, final authority, and settlement remain durable. Revenge rights expire
after 48 hours, retain at most three uses per opponent and 32 opponents, and are
revalidated on first deploy. Bot-camp cooldown history retains at most 128 live
30-minute entries. Only compact commands can change production outcomes. The
opt-in `CLASH_ALLOW_LEGACY_FRAME_COMMANDS=1` bridge exists for legacy migration
and compatibility tests, not normal operation.

Run the focused verification with:

```sh
node scripts/run-attack-domain-regression.mjs
npx tsx server/bot-attack-authority.spec.ts
npx tsx --test server/runtime/attack-service.spec.ts
```
