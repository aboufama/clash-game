# Two-path troop architecture (2026-07-18)

The trainable army now has one Army Camp progression and two specialist
Barracks paths. Biopunk is not a faction, building, visual route, or retained
army category.

## Army Camp progression

The highest completed, online Army Camp level unlocks the four foundational
troops. A camp that is still upgrading does not contribute an unlock level.

| Army Camp level | Core troop | Stable internal id |
|---|---|---|
| L1 | Barbarian | `warrior` |
| L2 | Archer | `archer` |
| L3 | Healer | `physicianscart` |
| L4 | Phalanx | `phalanx` |

The stable `warrior` and `physicianscart` ids preserve existing armies,
replays, art, and combat behavior while the player-facing names are Barbarian
and Healer. Core troops still require housing, gold, and food; they simply
read Army Camp progression instead of a faction Barracks.

## Canonical specialist paths

Each remaining Barracks unlocks one troop per completed level from L1 through
L7. The final node is the path flagship.

| Tier | Magic / Mystic | Mechanica / Steampunk |
|---|---|---|
| L1 | Goblin Plunderer (`goblinplunderer`) | Clockwork Beetle (`clockworkbeetle`) |
| L2 | Emberling (`wallbreaker`) | Battering Ram (`ram`) |
| L3 | Storm Mage (`stormmage`) | Mobile Mortar (`mobilemortar`) |
| L4 | Necromancer (`necromancer`) | Siege Tower (`siegetower`) |
| L5 | War Elephant (`warelephant`) | Trebuchet Crew (`trebuchet`) |
| L6 | Stone Golem (`golem`) | Ornithopter (`ornithopter`) |
| L7 flagship | Ice Golem (`icegolem`) | Da Vinci Tank (`davincitank`) |

The future-training catalog is exactly **18 troops**: four Army Camp troops
plus seven Mystic and seven Mechanica troops. Bound Spirit (`romanwarrior`)
and Skeleton (`skeleton`) remain generated-only and cannot be trained,
reserved directly, or deployed without their trained roots.

## One shared authority

`TroopDefinitions.ts` owns the derived catalogs:

- `CORE_TROOP_TYPES` and its Army Camp unlock mapping;
- `TROOP_TECH_TREES` / `FACTION_TROOP_TYPES` for the two L1-L7 paths;
- `TRAINABLE_TROOP_TYPES` and `PLAYER_TROOP_TYPES` for server validation and
  stable army/battle-bar order.

Consumers must not restate membership or infer progression from a global
index. `troopTrainingRequirement()` returns the Army Camp requirement for a
Core troop, the exact faction Barracks requirement for a specialist troop, or
`null` for generated/unknown ids. Both server runtimes use that same result.

Mystic uses `mystic_barracks`; Mechanica retains the historical `barracks`
id so existing villages remain in place. Both buildings keep their complete
L1-L9 structural/art curve: L1-L7 unlock troops, while L8-L9 are non-unlocking
Mastery levels. An absent, under-level, or upgrading required building cannot
unlock training. The global Lab still owns the shared L1-L3 troop-stat
multiplier.

Persisted known buildings are normalized against the current catalog during
server hydration. Legacy Barracks levels or in-progress targets above L9 clamp
to L9 immediately, stale upgrade timers are cleared, and layout/appearance
revision fences are bumped so clients and world postcards see one consistent
state instead of a delayed downgrade on the next layout save.

## Removed content and save sanitation

`biopunk_barracks`, Needleback, Razorwing Harpy, Vat Brute, Apex Chimera, and
Rift Djinn are removed end-to-end: definitions, types, training, server
authority, render dispatch, design slots, icons, committed sprites, wrecks,
and the packed index. The previously retained Spore Lobber and Mantis Stalker
are also no longer player troop ids. Existing saves and historical replays
self-clean unsupported building and troop ids without deleting the rest of an
account.

Goblin Plunderer and War Elephant survive as Mystic troops. The old Stone
Golem is restored to live training at Mystic L6. Battering Ram moves from Core
to Mechanica L2.

## Training UI and exact icons

The training modal renders the four-node Army Camp progression first, followed
by one Mystic and one Mechanica column derived directly from
`TROOP_TECH_TREES`. Locked Core cards identify the required Army Camp level;
locked specialist cards identify the required matching Barracks level.

Every portrait comes from that troop's exact committed bake through
`tools/art-preview/gen-troop-sprite-icons.mjs`. `TroopIcon` is shared by the
training cards, owned-army queue, and battle selector.

## Replay boundary

The live authoritative settlement version remains `ATTACK_SIMULATION_VERSION`
**6**. This change alters catalog eligibility and progression, not the combat
math of surviving troops, so no new settlement version is required.
