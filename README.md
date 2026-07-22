# Medieval Battle World

**A browser-based medieval strategy MMO where every village belongs to one
living world—and every building, troop, animation, and effect was designed
with Codex.**

Built for **OpenAI Build Week** with React, Phaser, TypeScript, Node.js, and
PostgreSQL.

> **GPT-5.6 · tens of millions of tokens · 37,371 baked pixel-art frames ·
> 100 sprite manifests · one playable shared world**

[Watch the 60 FPS gameplay trailer](tools/trailer/trailer-720.mp4) ·
[Explore the source](https://github.com/aboufama/clash-game) ·
[Read the architecture](docs/ARCHITECTURE.md)

**The centerpiece is the Design Arena:** a fully automated clean-room system
that sends the same mechanics-only contract to multiple isolated GPT-5.6
designers, proves every result inside the real game, and then stops for a human
to decide what is actually worth shipping.

## Overview

Medieval Battle World is an isometric base builder expanded into an MMO-like
shared world. Players claim persistent plots, construct villages, collect
resources, train armies, explore neighboring kingdoms, trade with traveling
merchants, and launch server-authoritative attacks without leaving the world
map behind.

- Neighboring players and persistent procedural kingdoms appear as complete
  isometric settlements rather than generic thumbnails.
- Eighteen trainable troops span a universal core roster and two independent
  technology paths: Mystic and Mechanica.
- Collision-aware pathfinding, walls, defensive targeting, projectiles,
  abilities, destruction, loot, trophies, and replays form one combat system.
- Roads, forests, lakes, weather, clouds, day/night lighting, caravans,
  villagers, animals, merchants, and ambient life make the world feel occupied.
- The server owns resources, armies, upgrades, plots, attack outcomes, and
  settlement. The browser owns presentation, never the reward.

## How GPT-5.6 was involved

Medieval Battle World was built as a long-horizon experiment in human-directed
AI creation. The project began by benchmarking the original Codex on GPT-5.1
and grew into a collaboration with GPT-5.6 spanning **tens of millions of
tokens**.

### Human role

The human remained the project's creative director and final authority:

- set the product vision, gameplay goals, visual standards, and constraints;
- decided how many candidates should enter each Design Arena tournament;
- reviewed comparable post-bake evidence rather than accepting first drafts;
- chose, mixed, rejected, or redirected designs based on taste;
- decided what was coherent, distinctive, and worthy of becoming canonical.

### Agent role — GPT-5.6 through Codex

GPT-5.6 was not used only to autocomplete code or generate a few concept
images. It worked across the responsibilities of an entire small studio:

- **Visual designer:** authored every building, troop, villager, animal,
  obstacle, wreck, projectile, and effect as deterministic vector drawing code.
- **Art-pipeline engineer:** created the renderer-driven workflow that converts
  those vectors into cleaned, packed, production-ready pixel-art sprites.
- **Design producer:** invented the clean-room Design Arena, coordinated
  isolated design candidates, prepared showcases, and promoted selected
  winners into the live game.
- **Gameplay engineer:** implemented building, training, pathfinding, combat,
  world simulation, procedural kingdoms, ambient life, weather, and replays.
- **Backend architect:** designed the server-authoritative domain model,
  deterministic simulation, PostgreSQL persistence, concurrency fences, and
  atomic battle settlement.
- **QA engineer:** built visual, simulation, persistence, pathing, attack,
  world, and render-quality regression suites.
- **Cinematographer and editor:** wrote the tools that direct the real game,
  record its canvas at 60 FPS, generate contact sheets, and assemble the final
  trailer.
- **Documentation engineer:** organized subsystem guides and generated a
  queryable knowledge graph so later Codex sessions can understand the codebase
  without repeatedly consuming the entire repository as context.

The important result is not that GPT-5.6 produced a large amount of code. It is
that it helped create the **systems that keep its own output coherent**:
selection instead of first-draft acceptance, deterministic asset generation,
real-surface visual review, authoritative state, reproducible films, and
regression gates around the finished product.

## The Design Arena — the central innovation

The **Design Arena** is the most important system in Medieval Battle World. It
is not a prompt template for asking GPT-5.6 to “make three concepts.” It is a
fully outlined, agentic production protocol encoded in the repository as the
executable `design-tournament` workflow.

The system automates the parts machines are unusually good at—parallel
exploration, mechanical compliance, exhaustive rendering, repeatable QA, and
integration hygiene—while explicitly refusing to automate the part humans are
best at: **taste**.

The human supplies the unit brief and chooses how many candidates should enter
the arena. From there, the workflow can coordinate **2–6 isolated designers per
unit**, in parallel, and return decision-ready evidence. It pauses for a human
to choose, mix, reject, or redirect the candidates. Once that creative decision
is made, the machinery takes over again to promote the winner safely.

### Why the clean room matters

Asking one model for multiple options inside one context creates anchoring: the
first idea leaks into the next, familiar motifs repeat, and “three designs”
become three variations of one design. Telling agents to be different is not
enough. The Arena **enforces divergence structurally**.

Before any designer starts, a preparation agent removes the old draw-function
body and replaces it with a neutral placeholder. It then produces a technical
contract containing everything the art must do—and nothing about how it should
look:

- draw signatures, registry wiring, dimensions, levels, and gameplay identity;
- aim, facing, firing, recoil, ability, and animation state fields;
- projectile-origin coupling and renderer integration constraints;
- isometric grounding, base/elevated layering, and deterministic timing rules;
- the required visual-quality and asset-pipeline contracts.

Colors, silhouettes, materials, motifs, poses, and previous artistic decisions
are deliberately excluded. Each artist is also forbidden from opening the old
sprites, renderer history, prior screenshots, or another candidate's file.
Isolation is a permission boundary, not a suggestion.

Each designer receives the same mechanics-only contract, writes one new source
file, and fills only its assigned registry anchors. That narrow write surface
lets many designers work simultaneously without contaminating one another's
ideas or colliding in the codebase.

### The automated tournament

| Stage | What the agent system does | What the human does |
| --- | --- | --- |
| Commission | Accepts one or more units and creates 2–6 independent tournament slots for each | Defines the brief and number of candidates |
| Preparation | Extracts the zero-visual-information contract, stubs old art, wires new-unit data when needed, and creates isolated registry anchors | Nothing |
| Divergent design | Launches one clean-room GPT-5.6 designer per slot in parallel; each authors and iterates a complete implementation | Nothing |
| Real-surface proof | Drives the live game in headless browsers across every level, day/night, idle motion, attacks, and directional poses | Nothing |
| Post-bake proof | Scratch-bakes every candidate through the shipping renderer, pixel quantizer, and alpha cleanup without touching committed assets | Nothing |
| Technical gate | Runs TypeScript checks, verifies every slot, and confirms that production assets remain unchanged | Nothing |
| Showcase | Produces labeled candidate evidence with concept notes, animation notes, and curated post-bake views | Reviews comparable evidence |
| Taste gate | Stops automation instead of pretending an objective metric can select the most compelling design | Chooses, mixes, rejects, or redirects |
| Promotion | Canonicalizes the winner, removes losing branches and assets, repacks atlases, reconciles exact frame counts, and runs regression gates | Approves the final result |

### Post-bake evidence, not AI self-assessment

The designers can iterate against live vector renders, but those previews are
never allowed into the final judging set. Pixel quantization changes thin
lines, silhouettes, contrast, animation readability, and small facial details.
Every candidate must therefore be baked into a scratch asset bank using the
same renderer and 1.35-world-pixel grid as the shipped game.

The Arena then captures the actual baked result across every relevant level,
day and night, the complete idle period, firing or attack sequences, and at
least eight headings for directional units. Each designer must inspect the
images it produced and curate 4–6 labeled finals. Typechecking proves that the
candidate can run; post-bake evidence proves that it deserves to be seen.

```mermaid
flowchart LR
    Brief["Human: brief + candidate count"] --> Orchestrator["Tournament orchestrator"]
    Orchestrator --> Prep["Prep agent: zero-visual contract"]
    Prep --> A["Isolated designer A"]
    Prep --> B["Isolated designer B"]
    Prep --> C["Isolated designer C"]
    A --> Runtime["Live-game visual iteration"]
    B --> Runtime
    C --> Runtime
    Runtime --> Bake["Scratch bake + pixel cleanup"]
    Bake --> Gate["Typecheck + asset-integrity gate"]
    Gate --> Showcase["Comparable post-bake showcase"]
    Showcase --> Taste["Human taste: choose · mix · reject"]
    Taste --> Promote["Canonical promotion + loser cleanup"]
    Promote --> Regress["Atlas pack + exact-count regressions"]
    Regress --> Game["Shipped game"]
```

Candidates can also be switched live in the developer Design Lab. Vector
dispatch and the baked SpriteBank resolve through the same selected slot, so a
judge never compares one implementation in preview and another in the game.
Committed production assets remain untouched until a selection is made.

The Arena has already selected the shipped Goblin Plunderer, Clockwork Beetle,
Healer's Cart, Siege Tower, Necromancer, Skeleton, Trebuchet, War Elephant,
Ornithopter, Foundry Bastion, and Athenaeum of War. Losing ideas were not left
as dead runtime branches: the promotion procedure made the winners canonical
and removed everything that did not ship.

This division of responsibility is the thesis of the project in miniature:
**GPT-5.6 can search an enormous creative space methodically, but the system
preserves a human as the final authority on what is beautiful, distinctive,
and worth keeping.**

[Read the executable workflow](.claude/workflows/design-tournament.js) ·
[Read the complete Design Arena specification](src/game/renderers/redesign/DESIGN_TOURNAMENTS.md)

## Codex-authored asset production

Every visual sprite begins as hand-authored vector code: isometric planes,
shadows, materials, tiny highlights, mechanical motion, attack anticipation,
and damage states. Animation is a deterministic function of time and
simulation state, so the pipeline can reproduce any pose exactly.

GPT-5.6 built an offline asset factory around the real Phaser renderer:

```text
Codex-authored vector renderer
        ↓
real in-game render path
        ↓
1.35-world-pixel quantization + alpha cleanup
        ↓
post-bake screenshots and visual review
        ↓
PNG frames + manifest + packed atlas
        ↓
Phaser SpriteBank at runtime
```

Rotating defenses are baked at 16 aim angles. Direction-aware troops include
owner palettes, levels, headings, idle loops, walk cycles, attack windups,
strikes, deaths, and special state-driven frames. Walls include 16 neighbor
topologies. Villagers, animals, travelers, obstacles, wrecks, and projectiles
pass through the same production contract.

The shipped bank contains **37,371 verified frames across 100 manifests**.
Exact counts, file boundaries, directions, animation states, atlas membership,
alpha, and render-policy rules are enforced by regression tests.

```mermaid
pie showData
    title 37,371 production frames by asset family
    "Troop animation" : 21168
    "Buildings" : 7949
    "Combat deaths" : 3888
    "Villagers" : 2924
    "Obstacles" : 872
    "Projectiles" : 326
    "Figures" : 168
    "Wrecks" : 76
```

[Read the sprite-asset pipeline](tools/art-preview/AGENTS_SPRITE_PIPELINE.md)

## Backend architecture

React owns the interface and Phaser owns presentation, but the browser is
treated as untrusted. The Node server owns durable truth.

Production runs on normalized PostgreSQL with ordered migrations, revision
fences, unique leases, row locking, compare-and-swap attack aggregates, and
serializable settlement transactions. A completed battle atomically commits
both participants, resources, troop consumption, trophies, replay, receipt,
ledger, notification, and outbox event.

- **Auth:** opaque device sessions, registered accounts, token rotation, abuse
  limits, guest leases, and plot lifecycle.
- **Village:** untrusted layout normalization, pricing, upgrades, production,
  staffing, population, and revision-fenced saves.
- **World:** versioned regions, durable plot claims, procedural wilderness,
  persistent bot villages, bounded map windows, and allocation.
- **Attack:** one deterministic command/state-machine aggregate for player,
  bot, practice, revenge, and replay targets.

Offline villages consume no permanent background tick. When a village is
touched, the server advances between meaningful event boundaries and arrives
at the same state continuous simulation would have produced. This keeps mass
simulation deterministic while making inactive players effectively free.

```mermaid
flowchart LR
    Human["Human creative direction"] --> GPT["GPT-5.6"]
    GPT --> Arena["Design Arena"]
    Arena --> Vector["Vector art"]
    Vector --> Bake["Bake + visual QA"]
    Bake --> Bank["37,371-frame SpriteBank"]
    Bank --> Phaser["Phaser world and combat"]
    React["React UI"] <--> Phaser
    Phaser <--> API["Node HTTP API"]
    API --> Domains["Auth · Village · World · Attack"]
    Domains --> Postgres["PostgreSQL authority"]
```

[Read the full system architecture](docs/ARCHITECTURE.md)

## Demo-video production

The trailer is another GPT-5.6-built production system. A cinematic capture
harness boots an isolated real world, authenticates a stable player, drives
the actual API, places and upgrades real buildings, trains troops, changes the
time of day, launches combat, and moves the live Phaser camera through scripted
beats.

Puppeteer records the canvas directly at 60 FPS through `MediaRecorder`.
Separate tools capture village progression, wilderness flyovers, neighboring
kingdoms, and a fortress siege; create contact sheets for visual QA; and
assemble the final cut with FFmpeg, music, titles, fades, and duration checks.

**Every shot comes from the running game. The demo is reproducible in code,
not a pre-render pretending to be gameplay.**

[Watch the trailer](tools/trailer/trailer-720.mp4) ·
[See the capture director](tools/trailer/record-trailer.mjs) ·
[See the progression shoot](tools/trailer/record-progression.mjs)

## Built with

**GPT-5.6 · Codex · TypeScript · React 19 · Phaser 3 · Node.js · PostgreSQL ·
Vite · Puppeteer · FFmpeg · PGlite · Canvas/WebGL · HTML/CSS**

## Run locally

Requires Node.js 20–24.

```bash
npm install
npm run dev:game
```

Vite starts the React/Phaser client and mounts the single-writer local JSON
compatibility server. The first browser receives a guest village automatically;
registering a username and password makes it available from other devices.

## Production and verification

Production uses PostgreSQL:

```bash
npm run build
DATABASE_URL=postgres://user:pass@host:5432/clash npm start
```

Run the complete verification chain with:

```bash
npm run verify
```

## Documentation

- [System architecture](docs/ARCHITECTURE.md)
- [Design Arena / clean-room tournaments](src/game/renderers/redesign/DESIGN_TOURNAMENTS.md)
- [Vector-to-pixel asset pipeline](tools/art-preview/AGENTS_SPRITE_PIPELINE.md)
- [Building art direction](src/game/renderers/BUILDING_ART_GUIDE.md)
- [Server and persistence model](server/persistence/README.md)
- [Documentation index](docs/README.md)

The repository ships a queryable knowledge graph at
`graphify-out/graph.json`. Contributors and AI agents can ask structural
questions with `graphify query`, `graphify explain`, and `graphify path` before
opening the implementation, then refresh it after meaningful changes with
`graphify update .`.

---

*Medieval Battle World is an original project inspired by the base-building
strategy genre. It is not affiliated with or endorsed by Supercell.*
