# Combat Navigation

Combat movement is intentionally separate from ambient village movement.

- `CombatNavigationSystem.ts` owns strategic target selection, reachable
  attack positions, wall-breach planning, and collision-safe displacement.
- `MainScene` owns the troop state machine, local separation, damage, and
  visuals.
- `PathfindingSystem.ts` is ambient-only (villagers, animals, camp figures).

## Target contract

A ground troop has two distinct targets:

- `strategicTarget`: the building it ultimately wants to destroy.
- `target`: the building it may damage now. This is either the strategic
  target or the first wall that must be breached to reach it.

A wall must never replace `strategicTarget`. Destroying the strategic target
cancels its breach immediately; destroying a wall preserves the strategic
target and replans through the opening.

## Planning contract

The planner searches for legal positions around a target footprint from which
the troop's range can reach it. Target footprints are never path goals.

Ground structures are physically solid. Enemy walls are traversed only in the
planner's *cost model* so it can compare detours with break time. The physical
route stops outside the first required wall and returns that wall as the
temporary blocker. Air/ghost movement bypasses structures explicitly.

`wallTraversalCost` changes a troop's willingness to breach; it is not
permission to walk through a live wall.

Nearby allies committed to the same objective apply a bounded affinity to a
popular breach. This keeps a cohort from wasting damage across adjacent wall
segments, but the affinity is intentionally weaker than wall break cost, so a
real gap or materially better route wins immediately.

## Movement contract

Local separation may adjust the desired direction, but it never owns
collision. `resolveMovement` checks the final displacement in at most
0.08-tile substeps, tries a route-preserving fallback, then safe axis slides.
There is no direct-steering fallback after planning failure.

Every structural add/remove increments the scene topology revision. Additions
invalidate old routes. A removal can only open geometry, so unrelated troops
keep their collision-safe route while a staggered replan looks for the new
shortcut; troops whose objective or blocker was removed replan urgently.

## Required regressions

Run:

```bash
npm run test:pathing
BASE=http://127.0.0.1:8788 node tools/art-preview/verify-pathing.mjs
```

The pure suite covers closed and tight wall loops, continuous start cells, the
deployment apron, deterministic/coordinated breach choice, opened gaps,
ranged attacks over walls, diagonal corners, large-delta tunneling, target
priority and lock hysteresis, and 150-troop planning. The browser suite covers
the real combat loop, including abandoning an obsolete wall, resuming through
a breach, ranged fire, cohort convergence, and Ram, Wall Breaker, and Ward
behavior.

When adding a troop, preserve these invariants:

1. A live ground troop never overlaps a live structure.
2. A blocker never replaces strategic intent.
3. Ranged units use legal outside attack positions instead of breaching when
   already in range.
4. Rams and special units use the same collision resolver as everyone else.
5. Identical inputs produce identical blockers and waypoints.
