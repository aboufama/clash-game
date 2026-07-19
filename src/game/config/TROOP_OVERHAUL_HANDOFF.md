# Two-path troop roster — handoff (2026-07-18)

The current contract is documented in
[`TROOP_FACTION_ARCHITECTURE.md`](./TROOP_FACTION_ARCHITECTURE.md). The client,
both server runtimes, save sanitizers, training screen, and battle presentation
must consume that one roster authority.

## Final roster

- Army Camp: Barbarian (`warrior`) L1, Archer L2, Healer
  (`physicianscart`) L3, Phalanx L4.
- Mystic Barracks: Goblin Plunderer, Emberling, Storm Mage, Necromancer, War
  Elephant, Stone Golem, Ice Golem.
- Mechanica Barracks: Clockwork Beetle, Battering Ram, Mobile Mortar, Siege
  Tower, Trebuchet, Ornithopter, Da Vinci Tank.
- Generated only: Bound Spirit and Skeleton.

This is **4 Core + 7 Mystic + 7 Mechanica = 18 trainable troops**. Mystic and
Mechanica unlock L1-L7 and retain L8-L9 as non-unlocking Mastery levels.

## Compatibility decisions

- `warrior` and `physicianscart` keep stable ids while displaying as
  Barbarian and Healer.
- Mechanica keeps the historical building id `barracks`; Mystic uses
  `mystic_barracks`.
- Goblin Plunderer and War Elephant move from the deleted Biopunk path into
  Mystic.
- Stone Golem returns to trainable Mystic progression.
- Battering Ram moves from Core into Mechanica.
- Unknown stored building/troop ids are discarded by the existing
  sanitizers; the rest of the account remains intact.

## Removed end-to-end

The Biopunk faction and `biopunk_barracks` are gone. Needleback, Razorwing,
Vat Brute, Apex Chimera, Rift Djinn, Spore Lobber, and Mantis Stalker are not
definitions, player troop types, visual routes, design variants, bakes, icons,
or packed-index entries. The retired Biopunk A/B/C tournament contract is no
longer active.

## Preserved art and simulation

Surviving promoted designs remain canonical, including Goblin Plunderer A,
Clockwork Beetle B, Healer/Physician's Cart B, Siege Tower C, Necromancer B,
Skeleton C, Trebuchet B, War Elephant A, and Ornithopter A. No new art was
authored by this roster collapse.

`ATTACK_SIMULATION_VERSION` is **8**. V8 evaluates each Siege Tower's recorded
deploy-to-nearest-Town-Hall ray and grants pathing credit only when it meets a
wall. Stored v7 attacks preserve the closed-loop gate; stored v4-v6 attacks
preserve the historical unconditional credit. The packed asset count and exact icon set are pinned by
`scripts/render-quality-regression.mjs`.

## Verification handoff

Before shipping a future roster edit:

1. verify Army Camp and both Barracks unlocks in both server runtimes;
2. verify removed ids self-clean and reject new training/deployment;
3. regenerate caravan soldiers, exact troop icons, and the packed index;
4. inspect the generated portrait sheet and surviving sprite manifests;
5. run `npm run verify` and a production build.
