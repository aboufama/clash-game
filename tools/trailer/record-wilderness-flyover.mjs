// Deterministic world commercial: one unbroken aerial path across a curated
// 10x10 country, with every wilderness archetype and twelve inhabited
// villages spanning starter hamlets through generated fortresses, followed by
// a wide shipped-cloud reveal and a dusk-to-night push into an untouched
// meadow for the player's future village.
//
// Unlike MediaRecorder capture, this renderer explicitly seeks every source
// frame and pipes 60 unique PNGs to ffmpeg. Camera motion therefore cannot
// inherit browser frame drops or acquire duplicate-frame judder.
//
//   CLASH_DATA_DIR=<fresh dir> CLASH_ALLOW_GUESTS=1 npx vite --port 5175
//   BASE=http://127.0.0.1:5175 \
//     node tools/trailer/record-wilderness-flyover.mjs
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

// Trailer scripts live beside, rather than inside, art-preview's small
// Puppeteer package. Resolve from that package without duplicating a browser
// dependency in the application bundle.
const previewRequire = createRequire(new URL('../art-preview/package.json', import.meta.url))
const puppeteerPackage = previewRequire('puppeteer-core')
const puppeteer = puppeteerPackage.default ?? puppeteerPackage

const BASE = process.env.BASE ?? 'http://127.0.0.1:5175'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const OUT = (process.env.OUT ?? new URL('./clips/', import.meta.url).pathname).replace(/\/$/, '')
const OUTPUT_NAME = process.env.NAME ?? 'wilderness-villages-cloud-night-flyover-1080'
const WIDTH = Number(process.env.WIDTH ?? 1920)
const HEIGHT = Number(process.env.HEIGHT ?? 1080)
const FPS = Number(process.env.FPS ?? 60)
const SEARCH_RADIUS = Number(process.env.SEARCH_RADIUS ?? 96)
const TOKEN_CACHE = process.env.TOKEN_CACHE
  ?? new URL('./.trailer-device-token.json', import.meta.url).pathname
const MUSIC = process.env.MUSIC
  ?? new URL('../../public/assets/audio/music/adventure.ogg', import.meta.url).pathname
const DURATION_MS = 30_000

// The capture searches for one real contiguous 10x10 window containing all
// eleven canonical ecology archetypes. Nothing is rearranged between plots.
const ARCHETYPE_KEYS = [
  'thicket',
  'pines',
  'deadwood',
  'crags',
  'boulder-lone-tree',
  'standing-stones',
  'marsh',
  'lake',
  'grove',
  'glade',
  'meadow'
]

const VILLAGE_SITES = [
  { dx: -4, dy: -4, name: 'Oakwatch', source: 'starter' },
  { dx: -3, dy: -4, name: 'Copper Hollow', source: 'starter' },
  { dx: -3, dy: -3, name: 'Fernbarrow', source: 'starter' },
  { dx: -2, dy: -3, name: 'Brookstead', source: 'starter' },
  { dx: 3, dy: 0, name: 'Pinecross', source: 'generated' },
  { dx: 2, dy: 0, name: 'Stonefield', source: 'generated' },
  { dx: 4, dy: 1, name: 'Eastmere', source: 'generated' },
  { dx: 3, dy: 1, name: 'Cloudrest', source: 'generated' },
  { dx: -3, dy: 2, name: 'Mossmere', source: 'generated' },
  { dx: -3, dy: 3, name: 'Amberwick', source: 'generated' },
  { dx: -2, dy: 3, name: 'Reedhaven', source: 'generated' },
  { dx: -2, dy: 4, name: 'Willowrest', source: 'generated' }
]

const PLOT_PITCH = 27
const PLOT_TILES = 25
const ATLAS_MIN = -5
const ATLAS_MAX = 4
const FOG_BOUND = { min: -137.4, max: 135.4 }

mkdirSync(OUT, { recursive: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

assert(Number.isFinite(WIDTH) && WIDTH >= 1280, `WIDTH must be at least 1280 (received ${WIDTH})`)
assert(Number.isFinite(HEIGHT) && HEIGHT >= 720, `HEIGHT must be at least 720 (received ${HEIGHT})`)
assert(Number.isInteger(FPS) && FPS >= 1 && FPS <= 60,
  `FPS must be an integer from 1 to 60 (received ${FPS})`)
assert(Number.isInteger(SEARCH_RADIUS) && SEARCH_RADIUS > 0,
  `SEARCH_RADIUS must be a positive integer (received ${SEARCH_RADIUS})`)

async function api(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  const raw = await response.text()
  let json = null
  try { json = raw ? JSON.parse(raw) : null } catch { /* raw carries the error */ }
  return { status: response.status, ok: response.ok, json, raw }
}

async function resolveBannerGate(page) {
  await sleep(900)
  await page.evaluate(() => {
    const modal = document.querySelector('[class*="banner"]')
    if (!modal) return
    const choice = modal.querySelector('[class*="option"], [class*="choice"], button')
    choice?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const confirm = [...modal.querySelectorAll('button')]
      .find(button => /choose|confirm|select|done|ok/i.test(button.textContent ?? ''))
    confirm?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(500)
}

/** Build a complete 10x10 country from the shipped distance-LOD wilderness
 * renderer and full-detail village postcard renderer, then install the real
 * WorldMapSystem fog, resident, and DayNight layers over it. */
async function prepareFlight(page) {
  return page.evaluate(async config => {
    const game = window.__clashGame
    const scene = game?.scene?.keys?.MainScene
    const mapSystem = scene?.worldMap
    const dayNight = scene?.dayNight
    if (!scene || !mapSystem || !dayNight || typeof mapSystem.renderNaturePostcard !== 'function') {
      throw new Error('MainScene wilderness, fog, or day/night renderer is unavailable')
    }

    const [
      { WildernessRenderer },
      hydrologyModule,
      { IsoUtils },
      { createStarterVillage },
      { BUILDING_DEFINITIONS },
      { computeStoneRoutes },
      { buildWildernessTopology },
      { SpriteBank },
      { STARTING_POPULATION, POPULATION_GROWTH_MS },
      {
        PROCEDURAL_VILLAGE_GENERATOR_VERSION,
        generateProceduralVillage,
        proceduralVillageDifficulty
      },
      { settledFrontierBotVillageSeedAt }
    ] = await Promise.all([
      import('/src/game/renderers/WildernessRenderer.ts'),
      import('/src/game/config/WorldHydrology.ts'),
      import('/src/game/utils/IsoUtils.ts'),
      import('/src/game/config/StarterVillage.ts'),
      import('/src/game/config/GameDefinitions.ts'),
      import('/src/game/renderers/StonePathRenderer.ts'),
      import('/src/game/systems/WildernessTopology.ts'),
      import('/src/game/render/SpriteBank.ts'),
      import('/server/domain/village/simulation.ts'),
      import('/server/domain/world/procedural-village.ts'),
      import('/server/domain/world/generation.ts')
    ])
    const { classifyHydrologyPlot } = hydrologyModule
    const AUTHORITY_EPOCH = 1_000_000
    const BOT_FRONTIER_RADIUS = 999
    if (STARTING_POPULATION !== 3 || POPULATION_GROWTH_MS !== 3 * 60_000) {
      throw new Error('trailer population chronology no longer matches server simulation constants')
    }

    // Offline capture must never sample the finite streaming window where a
    // catalogued figure is intentionally held empty. Load the real baked
    // villager atlas before any resident carrier is registered.
    await SpriteBank.waitUntilSettled()
    await SpriteBank.ensureUnits(scene, [{ kind: 'villagers', unit: 'villager' }])
    if (SpriteBank.enabled && !SpriteBank.backed('villagers', 'villager')) {
      throw new Error('baked villager atlas did not settle before capture')
    }

    const seedVersion = Number.isSafeInteger(mapSystem.presentationSeedVersion)
      ? mapSystem.presentationSeedVersion
      : 0
    const keys = WildernessRenderer.archetypeKeys()
    if (keys.length !== config.archetypeKeys.length) {
      throw new Error(`capture lists ${config.archetypeKeys.length} entries for ${keys.length} canonical archetypes`)
    }
    const expected = new Set(keys)
    const requestedKeys = new Set(config.archetypeKeys)
    const missingKeys = keys.filter(key => !requestedKeys.has(key))
    const unknownKeys = [...requestedKeys].filter(key => !expected.has(key))
    if (missingKeys.length || unknownKeys.length || requestedKeys.size !== config.archetypeKeys.length) {
      throw new Error(`invalid archetype inventory: missing=${missingKeys.join(',')} unknown=${unknownKeys.join(',')}`)
    }

    // Find ONE contiguous real world window. Ecology, hydrology, checker
    // coordinates, road topology, and postcard seeds all share these exact
    // absolute coordinates; the trailer never rearranges unrelated parcels.
    const villageCellKeys = new Set(config.villages.map(site => `${site.dx},${site.dy}`))
    const offsets = []
    for (let dy = config.atlasMin; dy <= config.atlasMax; dy += 1) {
      for (let dx = config.atlasMin; dx <= config.atlasMax; dx += 1) offsets.push({ dx, dy })
    }
    const inspectCountry = (centerX, centerY) => {
      const centreNature = WildernessRenderer.natureAt(centerX, centerY, seedVersion)
      const centreHydrology = classifyHydrologyPlot(centerX, centerY, seedVersion)
      if (centreNature.key !== 'meadow' || centreHydrology.protected) return null
      const representatives = new Map()
      const plots = []
      for (const { dx, dy } of offsets) {
        const x = centerX + dx
        const y = centerY + dy
        const nature = WildernessRenderer.natureAt(x, y, seedVersion)
        const hydrology = classifyHydrologyPlot(x, y, seedVersion)
        const village = villageCellKeys.has(`${dx},${dy}`)
        if (village && hydrology.protected) return null
        const plot = {
          x,
          y,
          dx,
          dy,
          key: nature.key,
          label: nature.label,
          hydrology: hydrology.protected,
          hydrologyFeatures: hydrology.features.map(feature => feature.id),
          village
        }
        plots.push(plot)
        if (village || hydrology.protected) continue
        if (dx === 0 && dy === 0) representatives.set('meadow', plot)
        else if (!representatives.has(nature.key)) representatives.set(nature.key, plot)
      }
      if (config.archetypeKeys.some(key => !representatives.has(key))) return null
      return { center: { x: centerX, y: centerY }, plots, representatives }
    }
    let country = null
    for (let ring = 0; ring <= config.searchRadius && !country; ring += 1) {
      for (let y = -ring; y <= ring && !country; y += 1) {
        for (let x = -ring; x <= ring; x += 1) {
          if (ring > 0 && Math.max(Math.abs(x), Math.abs(y)) !== ring) continue
          country = inspectCountry(x, y)
          if (country) break
        }
      }
    }
    if (!country) throw new Error(`no contiguous 10x10 country found within radius ${config.searchRadius}`)
    // Generated settlements use the SAME coordinate-derived presentation seed
    // and server-only village generator as the persisted world. The four NW
    // sites remain true player starters; every other site gets its natural
    // established/strong/elite/fortress band for this exact contiguous map.
    const generatedVillageByIndex = new Map()
    const persistentBotVillageIdAt = async (worldId, x, y) => {
      // Browser-equivalent of server/domain/world/bot-village-identity.ts.
      // Importing that tiny server module here would pull node:crypto into
      // Vite; Web Crypto produces the same SHA-256 coordinate identity.
      const bytes = new TextEncoder().encode(`${worldId}\u0000${x}\u0000${y}`)
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
      const hex = [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
      return `bot_${hex.slice(0, 24)}`
    }
    for (let index = 0; index < config.villages.length; index += 1) {
      const site = config.villages[index]
      if (site.source !== 'generated') continue
      const coordinate = { x: country.center.x + site.dx, y: country.center.y + site.dy }
      const seed = settledFrontierBotVillageSeedAt(coordinate, {
        frontierRadius: BOT_FRONTIER_RADIUS,
        presentationSeedVersion: seedVersion
      })
      if (seed === null) throw new Error(`no coordinate-derived bot seed for ${site.name}`)
      const difficulty = proceduralVillageDifficulty(seed)
      const ownerId = await persistentBotVillageIdAt('main', coordinate.x, coordinate.y)
      const world = generateProceduralVillage(seed, {
        id: ownerId,
        ownerId
      })
      generatedVillageByIndex.set(index, { coordinate, seed, difficulty, world })
    }

    // Snapshot rendering is allowed to fall back to vector authoring art only
    // when the pixel bank is disabled. Load every generated building/obstacle
    // before any postcard capture so a dense fortress cannot bake half-empty.
    const postcardRequirements = new Map()
    const requireUnit = (kind, unit) => postcardRequirements.set(`${kind}:${unit}`, { kind, unit })
    for (const type of [
      'town_hall', 'army_camp', 'mine', 'farm', 'storage', 'barracks', 'watchtower'
    ]) requireUnit('buildings', type)
    for (const type of ['tree_oak', 'grass_patch', 'rock_small']) requireUnit('obstacles', type)
    for (const { world } of generatedVillageByIndex.values()) {
      for (const building of world.buildings ?? []) requireUnit('buildings', building.type)
      for (const obstacle of world.obstacles ?? []) requireUnit('obstacles', obstacle.type)
    }
    await SpriteBank.ensureUnits(scene, postcardRequirements.values())
    const missingPostcardUnits = [...postcardRequirements.values()]
      .filter(requirement => SpriteBank.enabled && !SpriteBank.backed(requirement.kind, requirement.unit))
      .map(requirement => `${requirement.kind}:${requirement.unit}`)
    if (missingPostcardUnits.length) {
      throw new Error(`postcard atlases did not settle: ${missingPostcardUnits.join(', ')}`)
    }

    const showcases = config.archetypeKeys.map(key => country.representatives.get(key))
    const showcaseCells = new Set(showcases.map(plot => `${plot.dx},${plot.dy}`))
    const fillers = country.plots.filter(plot => !plot.village && !showcaseCells.has(`${plot.dx},${plot.dy}`))

    // Hide the live village and UI-owned scene objects before creating the
    // cinematic country. The scene is later paused, but paused Phaser scenes
    // remain rendered by the game and therefore still produce exact frames.
    mapSystem.closePanel?.()
    scene.input.enabled = false
    scene.tweens.pauseAll()
    for (const runningScene of game.scene.getScenes(true)) {
      for (const child of [...runningScene.children.list]) child.setVisible?.(false)
      if (runningScene !== scene) runningScene.scene.pause()
    }
    document.querySelectorAll('.plot-bubble, .building-bubble, .village-bubble-layer')
      .forEach(node => { node.style.display = 'none' })
    scene.weather?.setWeatherOverride?.(0)

    // No old village light may relight behind the future-village meadow.
    dayNight.clearLights?.()
    for (const key of [...(dayNight.postcardRigs?.keys?.() ?? [])]) {
      dayNight.clearPostcardLights?.(key)
    }
    mapSystem.neighborLifeSim?.destroy?.()
    mapSystem.neighborLifeSim = null
    mapSystem.views = new Map()
    if (Array.isArray(scene.buildings)) scene.buildings.length = 0
    dayNight.lanternProvider = null
    dayNight.setFestivalGlow?.(null)
    dayNight.strength = 1
    mapSystem.nextRefreshAt = Number.POSITIVE_INFINITY
    mapSystem.update = () => {}
    scene.scene.pause()

    // Authoritative target-coordinate kinds must exist before the first
    // postcard bake: they decide which lawn corners reveal a surviving road.
    mapSystem.myPlot = { ...country.center }
    mapSystem.viewRadiusValue = Math.max(Math.abs(config.atlasMin), Math.abs(config.atlasMax))
    const villageSourceByCell = new Map(config.villages.map(site => [
      `${site.dx},${site.dy}`,
      site.source
    ]))
    mapSystem.knownPlotKindHints = new Map(country.plots.map(plot => {
      const source = villageSourceByCell.get(`${plot.dx},${plot.dy}`)
      return [
        `${plot.x},${plot.y}`,
        source === 'generated' ? 'bot' : source === 'starter' ? 'player' : 'empty'
      ]
    }))

    const camera = scene.cameras.main
    camera.stopFollow()
    camera.setRotation(0)
    // NEAREST textures preserve the pixel contract. Rounding the camera
    // itself was a source of low-speed stepping in the previous flyover.
    camera.roundPixels = false
    camera.setBackgroundColor('#eaf0f6')
    camera.fadeEffect?.reset?.()

    // Rebuild the production packed-earth atlas at radius five. The ordinary
    // game requests radius two; this uses the exact same painter over the
    // larger cinematic window. Wild/wild seams are reclaimed after all
    // postcards exist, while every settlement keeps its serviced roads.
    for (const key of [
      'wilderness',
      'wildernessLinks',
      'wildernessGapSurface',
      'worldHydrologyLayer',
      'worldHydrologyLifeLayer',
      'worldHydrologyMaskGfx'
    ]) {
      mapSystem[key]?.destroy?.()
      mapSystem[key] = null
    }
    mapSystem.worldHydrologyMask?.destroy?.()
    mapSystem.worldHydrologyMask = null
    mapSystem.wildernessTopology = null
    mapSystem.wildernessLinkSignature = null
    mapSystem.ensureWilderness(mapSystem.viewRadiusValue)
    if (!mapSystem.wilderness?.active || mapSystem.wilderness.commandBuffer?.length === 0) {
      throw new Error('production country-road atlas did not materialize')
    }

    const allViews = []
    const natureViews = []
    const villageViews = []
    const viewKey = (dx, dy) => `${country.center.x + dx},${country.center.y + dy}`

    const makeNatureView = (plot, targetDx, targetDy, suffix) => {
      const stagedPlot = {
        x: plot.x,
        y: plot.y,
        kind: 'empty',
        settleable: targetDx === 0 && targetDy === 0,
        seed: plot.seed ?? undefined
      }
      const view = mapSystem.createView(viewKey(targetDx, targetDy), stagedPlot, targetDx, targetDy)
      // Passing the real target offset activates the shipped distance LOD:
      // the 75 outer cards stay lean while the central destination remains
      // sharp enough for the final push-in.
      mapSystem.renderNaturePostcard(view, targetDx, targetDy)
      if (!view.rt?.active || view.contentKind !== 'nature') {
        throw new Error(`postcard render failed for ${suffix}`)
      }
      view.renderedRevision = mapSystem.wildernessRevisionAt(plot.x, plot.y)
      mapSystem.views.set(view.key, view)
      allViews.push(view)
      natureViews.push(view)
      return view
    }

    const transformPlacement = (placement, villageIndex) => {
      const info = BUILDING_DEFINITIONS[placement.type]
      let gridX = placement.gridX
      let gridY = placement.gridY
      if ((villageIndex & 1) !== 0) gridX = 25 - info.width - gridX
      if ((villageIndex & 2) !== 0) gridY = 25 - info.height - gridY
      return { ...placement, gridX, gridY, level: 1 }
    }

    const makeVillageView = (site, villageIndex) => {
      const generated = generatedVillageByIndex.get(villageIndex)
      const source = site.source === 'generated' ? 'generated' : 'starter'
      let ownerId
      let world
      let revision
      let population
      let difficulty = 'starter'
      let seed = null

      if (source === 'generated') {
        if (!generated) throw new Error(`generated village data is missing for ${site.name}`)
        // Keep the server generator's placements, cohort wall level,
        // obstacles, population, resources, banner, and level distribution
        // intact. Only the plot wrapper below supplies postcard provenance.
        world = generated.world
        ownerId = world.ownerId
        seed = generated.seed
        difficulty = generated.difficulty
        revision = `pv${PROCEDURAL_VILLAGE_GENERATOR_VERSION}:${seed}`
        population = world.life.population
      } else {
        ownerId = `trailer-village-${villageIndex}`
        let buildingIndex = 0
        const starter = createStarterVillage(() => `${ownerId}:building:${buildingIndex++}`)
        const additions = [
          { type: 'farm', gridX: 15, gridY: 10, level: 1 },
          ...(villageIndex % 2 === 0
            ? [{ type: 'storage', gridX: 8, gridY: 15, level: 1 }]
            : []),
          ...(villageIndex % 3 === 0 ? [{ type: 'barracks', gridX: 15, gridY: 15, level: 1 }] : []),
          ...(villageIndex % 4 === 0 ? [{ type: 'watchtower', gridX: 8, gridY: 7, level: 1 }] : [])
        ].map(building => ({ id: `${ownerId}:building:${buildingIndex++}`, ...building }))
        const buildings = [...starter.buildings, ...additions]
          .map(building => transformPlacement(building, villageIndex))

        const rawObstacles = [
          { id: `${ownerId}:oak`, type: 'tree_oak', gridX: 4, gridY: 17 },
          { id: `${ownerId}:grass`, type: 'grass_patch', gridX: 18, gridY: 8 },
          { id: `${ownerId}:stone`, type: 'rock_small', gridX: 6, gridY: 7 }
        ]
        const obstacles = rawObstacles.map(obstacle => {
          const info = { width: obstacle.type === 'tree_oak' ? 2 : 1, height: obstacle.type === 'tree_oak' ? 2 : 1 }
          let gridX = obstacle.gridX
          let gridY = obstacle.gridY
          if ((villageIndex & 1) !== 0) gridX = 25 - info.width - gridX
          if ((villageIndex & 2) !== 0) gridY = 25 - info.height - gridY
          return { ...obstacle, gridX, gridY }
        })
        revision = `trailer-starter-v4:${villageIndex}`
        population = 4 + (villageIndex % 3)
        const birthCount = population - STARTING_POPULATION
        const latestBirthAt = AUTHORITY_EPOCH - 20_000 - (villageIndex % 3) * 15_000
        const bornAt = Array.from({ length: birthCount }, (_, index) =>
          latestBirthAt - (birthCount - index - 1) * POPULATION_GROWTH_MS)
        // Paving and population advance on the real server clock: roughly
        // three minutes per new resident, and nine minutes to full stone.
        const stoneMaturity = population === 4 ? 0.42 : population === 5 ? 0.72 : 1
        world = {
          id: `${ownerId}:world`,
          ownerId,
          username: site.name,
          buildings,
          obstacles,
          resources: { gold: 250, ore: 40, food: 60 },
          stoneMaturity,
          wallLevel: 1,
          lastSaveTime: 0,
          revision,
          life: {
            version: 1,
            identity: `${ownerId}:life`,
            population,
            bornAt,
            simulatedThrough: AUTHORITY_EPOCH
          },
          banner: {
            palette: villageIndex % 8,
            emblem: (villageIndex * 3) % 6,
            pattern: (villageIndex * 2) % 5
          }
        }
      }

      const stoneRoutes = computeStoneRoutes(world.buildings)
      if (stoneRoutes.length < 2 || (site.name === 'Stonefield' && stoneRoutes.length < 3)) {
        throw new Error(`${site.name} lacks a canonical internal road network`)
      }
      const plotX = country.center.x + site.dx
      const plotY = country.center.y + site.dy
      const plot = {
        x: plotX,
        y: plotY,
        kind: source === 'generated' ? 'bot' : 'player',
        settleable: false,
        ownerId,
        username: world.username,
        revision,
        ...(seed === null ? {} : { seed }),
        stoneMaturity: world.stoneMaturity,
        world
      }
      const view = mapSystem.createView(viewKey(site.dx, site.dy), plot, site.dx, site.dy)
      view.sourceWorld = world
      view.sourceRevision = revision
      view.knownRevision = revision
      mapSystem.views.set(view.key, view)
      mapSystem.renderSnapshot(view, world, site.dx, site.dy)
      if (!view.rt?.active || view.contentKind !== 'village' || !view.residentsRegistered) {
        throw new Error(`village postcard failed for ${site.name}`)
      }
      view.renderedRevision = revision
      allViews.push(view)
      villageViews.push(view)
      return {
        view,
        world,
        plot,
        site,
        source,
        difficulty,
        seed,
        generatorVersion: source === 'generated' ? PROCEDURAL_VILLAGE_GENERATOR_VERSION : null,
        population,
        stoneRoutes
      }
    }

    const archetypeViews = []
    const fillerViews = []
    const villageRecords = []
    const contentByCell = new Map()
    for (const plot of showcases) contentByCell.set(`${plot.dx},${plot.dy}`, { kind: 'archetype', plot })
    for (const plot of fillers) contentByCell.set(`${plot.dx},${plot.dy}`, { kind: 'filler', plot })
    for (let index = 0; index < config.villages.length; index += 1) {
      const site = config.villages[index]
      contentByCell.set(`${site.dx},${site.dy}`, { kind: 'village', site, index })
    }
    let stagedCount = 0
    for (let dy = config.atlasMin; dy <= config.atlasMax; dy += 1) {
      for (let dx = config.atlasMin; dx <= config.atlasMax; dx += 1) {
        const content = contentByCell.get(`${dx},${dy}`)
        if (!content) throw new Error(`missing staged content at ${dx},${dy}`)
        if (content.kind === 'village') {
          villageRecords.push(makeVillageView(content.site, content.index))
        } else {
          const view = makeNatureView(content.plot, dx, dy, `${content.kind}:${content.plot.key}`)
          if (content.kind === 'archetype') {
            view.trailerArchetypeKey = content.plot.key
            archetypeViews.push(view)
          }
          else fillerViews.push(view)
        }
        stagedCount += 1
        // Let the async point-sample/quantize work drain in small batches;
        // this keeps 100 cards from peaking together in GPU scratch memory.
        if (stagedCount % 8 === 0) {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        }
      }
    }
    mapSystem.myPlot = { ...country.center }
    mapSystem.rebuildWildernessLinks(country.center, false)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (!mapSystem.wildernessLinks?.active || !mapSystem.wildernessGapSurface?.active) {
      throw new Error('production wilderness/road topology layers did not materialize')
    }
    const atlasTopology = buildWildernessTopology(
      country.center,
      mapSystem.viewRadiusValue,
      [...mapSystem.views.values()].map(view => view.plot),
      { centerOccupied: false }
    )
    const roadSegments = []
    for (let dy = config.atlasMin; dy <= config.atlasMax; dy += 1) {
      for (let boundaryX = config.atlasMin + 1; boundaryX <= config.atlasMax; boundaryX += 1) {
        const key = `v:${boundaryX},${dy}`
        if (atlasTopology.verticalJoinKeys.has(key)) continue
        const gx = boundaryX * config.pitch - config.pitch + config.tiles + 1
        const gy = dy * config.pitch + config.tiles / 2
        roadSegments.push({ key, axis: 'vertical', gx, gy, ...IsoUtils.cartToIso(gx, gy) })
      }
    }
    for (let boundaryY = config.atlasMin + 1; boundaryY <= config.atlasMax; boundaryY += 1) {
      for (let dx = config.atlasMin; dx <= config.atlasMax; dx += 1) {
        const key = `h:${dx},${boundaryY}`
        if (atlasTopology.horizontalJoinKeys.has(key)) continue
        const gx = dx * config.pitch + config.tiles / 2
        const gy = boundaryY * config.pitch - config.pitch + config.tiles + 1
        roadSegments.push({ key, axis: 'horizontal', gx, gy, ...IsoUtils.cartToIso(gx, gy) })
      }
    }
    const roadTargets = Object.fromEntries(config.villages.map(site => {
      const midX = site.dx * config.pitch + config.tiles / 2
      const midY = site.dy * config.pitch + config.tiles / 2
      const westX = site.dx * config.pitch - 1
      const eastX = (site.dx + 1) * config.pitch - 1
      const northY = site.dy * config.pitch - 1
      const southY = (site.dy + 1) * config.pitch - 1
      const points = [
        { gx: westX, gy: midY },
        { gx: eastX, gy: midY },
        { gx: midX, gy: northY },
        { gx: midX, gy: southY }
      ].map(point => ({ ...point, ...IsoUtils.cartToIso(point.gx, point.gy) }))
      return [site.name, { key: site.name, points }]
    }))
    const servicedVillages = Object.fromEntries(config.villages.map(site => {
      const seamKeys = [
        `v:${site.dx},${site.dy}`,
        `v:${site.dx + 1},${site.dy}`,
        `h:${site.dx},${site.dy}`,
        `h:${site.dx},${site.dy + 1}`
      ]
      return [site.name, seamKeys.filter(key => {
        if (key.startsWith('v:')) return !atlasTopology.verticalJoinKeys.has(key)
        return !atlasTopology.horizontalJoinKeys.has(key)
      })]
    }))
    if (Object.values(servicedVillages).some(edges => edges.length !== 4)) {
      throw new Error(`one or more villages lacks four serviced road edges: ${JSON.stringify(servicedVillages)}`)
    }
    const villageSiteByKey = new Map(config.villages.map(site => [`${site.dx},${site.dy}`, site]))
    const adjacentVillageRoads = []
    for (const site of config.villages) {
      for (const [stepX, stepY] of [[1, 0], [0, 1]]) {
        const neighbor = villageSiteByKey.get(`${site.dx + stepX},${site.dy + stepY}`)
        if (neighbor) adjacentVillageRoads.push({ from: site.name, to: neighbor.name })
      }
    }
    const unvisitedVillages = new Set(villageSiteByKey.keys())
    let settlementClusterCount = 0
    while (unvisitedVillages.size > 0) {
      settlementClusterCount += 1
      const pending = [unvisitedVillages.values().next().value]
      while (pending.length > 0) {
        const key = pending.pop()
        if (!unvisitedVillages.delete(key)) continue
        const [x, y] = key.split(',').map(Number)
        for (const [stepX, stepY] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const neighborKey = `${x + stepX},${y + stepY}`
          if (unvisitedVillages.has(neighborKey)) pending.push(neighborKey)
        }
      }
    }
    if (adjacentVillageRoads.length < 8 || settlementClusterCount > 3) {
      throw new Error(`villages do not form convincing road-connected hamlets: ${adjacentVillageRoads.length} links across ${settlementClusterCount} clusters`)
    }
    const futureVillageRoadFree = [
      atlasTopology.verticalJoinKeys.has('v:0,0'),
      atlasTopology.verticalJoinKeys.has('v:1,0'),
      atlasTopology.horizontalJoinKeys.has('h:0,0'),
      atlasTopology.horizontalJoinKeys.has('h:0,1')
    ].every(Boolean)
    if (!futureVillageRoadFree) throw new Error('future-village meadow is touched by a country road')
    const archetypeViewByKey = new Map(archetypeViews.map(view => [view.trailerArchetypeKey, view]))

    const centerFor = (dx, dy) => {
      const p = IsoUtils.cartToIso(
        dx * config.pitch + config.tiles / 2,
        dy * config.pitch + config.tiles / 2
      )
      return { x: p.x, y: p.y }
    }
    const targets = Object.fromEntries(showcases.map(plot => [plot.key, {
      key: plot.key,
      label: plot.label,
      ...centerFor(plot.dx, plot.dy)
    }]))
    const villageTargets = villageRecords.map(record => ({
      key: record.site.name,
      ...centerFor(record.site.dx, record.site.dy),
      dx: record.site.dx,
      dy: record.site.dy
    }))
    const villagesByName = Object.fromEntries(villageTargets.map(target => [target.key, target]))
    const meadowCenter = targets.meadow
    const fogCartCenter = (config.fogBound.min + config.fogBound.max) / 2
    const fogCenter = IsoUtils.cartToIso(fogCartCenter, fogCartCenter)
    // Enter through the northeast cloud bank on the atlas's outermost plot
    // instead of presenting the whole country as a flat board.
    const fogEntry = IsoUtils.cartToIso(
      config.atlasMax * config.pitch + config.tiles / 2,
      config.atlasMin * config.pitch + config.tiles / 2
    )

    const stonefieldCenter = villagesByName.Stonefield
    const stonefieldRecord = villageRecords.find(record => record.site.name === 'Stonefield')
    const stonefieldView = stonefieldRecord?.view
    const stonefieldSim = stonefieldView
      ? mapSystem.neighborLife.sims?.get?.(stonefieldView.key)
      : null
    if (!stonefieldCenter || !stonefieldRecord || !stonefieldView || !stonefieldSim) {
      throw new Error('Stonefield hero village or its resident simulation is unavailable')
    }
    if (stonefieldSim.entities.length !== stonefieldRecord.population
      || stonefieldSim.entities.some(entity => entity.route.some(point =>
        !Number.isFinite(point.x) || !Number.isFinite(point.y)
        || point.x < 0 || point.x > 25 || point.y < 0 || point.y > 25))) {
      throw new Error('Stonefield residents do not own valid in-plot simulation routes')
    }
    // Finish on the meadow's warm open slope rather than centring its ancient
    // oak. The landmark remains in the upper-right as context while the empty
    // buildable ground and fireflies own the final composition.
    const meadowLanding = IsoUtils.cartToIso(9.7, 15.3)
    const heroStart = { x: stonefieldCenter.x + 360, y: stonefieldCenter.y + 180 }
    const heroEnd = { x: stonefieldCenter.x - 360, y: stonefieldCenter.y - 180 }
    // Leave parallel to Stonefield's north frontage. Its complete rounded
    // road bend clears the lower frame before the camera crosses joined
    // wilderness grass toward the future-village meadow.
    const frontageLead = { x: heroEnd.x - 300, y: heroEnd.y - 150 }
    const frontageTangent = { x: heroEnd.x - 600, y: heroEnd.y - 300 }
    const frontageExit = { x: heroEnd.x - 1_200, y: heroEnd.y - 600 }

    // Broad controls replace the old one-point Grove/Mossmere hairpin. A
    // clamped cubic B-spline stays C2-continuous through every bend; unlike
    // the old interpolating spline it cannot whip around a close waypoint.
    // The raw tour deliberately names every ecology and settlement corridor;
    // a spatial fairing pass below turns these compositional anchors into one
    // country-scale aerial curve without losing their coverage.
    const countryWaypoints = [
      { x: fogEntry.x, y: fogEntry.y },
      targets.deadwood,
      targets.pines,
      targets.thicket,
      targets['boulder-lone-tree'],
      targets.glade,
      targets.grove,
      { x: -800, y: -3500 },
      { x: -1800, y: -3000 },
      { x: -3000, y: -2400 },
      { x: -4000, y: -1700 },
      { x: -4500, y: -1200 },
      { x: -4952, y: -84 },
      { x: -5002, y: 416 },
      { x: -4752, y: 616 },
      { x: -4452, y: 916 },
      { x: -3906, y: 1164 },
      targets.lake,
      { x: -3576, y: 1764 },
      targets.marsh,
      { x: -2800, y: 2500 },
      targets.crags,
      targets['standing-stones'],
      { x: 1000, y: 3400 },
      { x: 2500, y: 3100 },
      { x: 3500, y: 2500 },
      { x: 3400, y: 2100 },
      { x: 3000, y: 1850 },
      { x: 2600, y: 1650 },
      { x: 2300, y: 1530 },
      heroStart
    ]
    const routeControls = [
      ...countryWaypoints,
      stonefieldCenter,
      stonefieldCenter,
      heroEnd,
      frontageLead,
      frontageTangent,
      frontageExit,
      { x: 0, y: 420 },
      meadowLanding
    ]
    // Triple endpoint multiplicity clamps a uniform cubic B-spline to the
    // exact opening and landing without sacrificing C2 interior continuity.
    const knots = [
      routeControls[0],
      routeControls[0],
      ...routeControls,
      routeControls.at(-1),
      routeControls.at(-1)
    ]

    const bspline = (points, t) => {
      const segmentCount = points.length - 3
      const scaled = Math.max(0, Math.min(0.999999999, t)) * segmentCount
      const i = Math.floor(scaled)
      const u = scaled - i
      const p0 = points[i]
      const p1 = points[i + 1]
      const p2 = points[i + 2]
      const p3 = points[i + 3]
      const u2 = u * u
      const u3 = u2 * u
      const coord = key => (
        (1 - 3 * u + 3 * u2 - u3) * p0[key]
        + (4 - 6 * u2 + 3 * u3) * p1[key]
        + (1 + 3 * u + 3 * u2 - 3 * u3) * p2[key]
        + u3 * p3[key]
      ) / 6
      return { x: coord('x'), y: coord('y') }
    }
    const samples = []
    const SAMPLE_COUNT = 2_400
    for (let i = 0; i <= SAMPLE_COUNT; i += 1) {
      const point = bspline(knots, i / SAMPLE_COUNT)
      samples.push(point)
    }
    // Four wide box-fairing passes spread every necessary change of heading
    // over several hundred world pixels. Affine endpoint correction preserves
    // the exact cloud-bank entry and final meadow landing after each pass.
    const PATH_FAIR_RADIUS = 120
    const PATH_FAIR_PASSES = 4
    for (let pass = 0; pass < PATH_FAIR_PASSES; pass += 1) {
      const originalStart = samples[0]
      const originalEnd = samples.at(-1)
      const prefixX = [0]
      const prefixY = [0]
      for (const point of samples) {
        prefixX.push(prefixX.at(-1) + point.x)
        prefixY.push(prefixY.at(-1) + point.y)
      }
      const faired = samples.map((_, index) => {
        const lo = Math.max(0, index - PATH_FAIR_RADIUS)
        const hi = Math.min(samples.length - 1, index + PATH_FAIR_RADIUS)
        const leftPad = Math.max(0, PATH_FAIR_RADIUS - index)
        const rightPad = Math.max(0, index + PATH_FAIR_RADIUS - (samples.length - 1))
        const count = PATH_FAIR_RADIUS * 2 + 1
        return {
          x: (prefixX[hi + 1] - prefixX[lo]
            + leftPad * originalStart.x + rightPad * originalEnd.x) / count,
          y: (prefixY[hi + 1] - prefixY[lo]
            + leftPad * originalStart.y + rightPad * originalEnd.y) / count
        }
      })
      const startCorrection = {
        x: originalStart.x - faired[0].x,
        y: originalStart.y - faired[0].y
      }
      const endCorrection = {
        x: originalEnd.x - faired.at(-1).x,
        y: originalEnd.y - faired.at(-1).y
      }
      for (let index = 0; index < faired.length; index += 1) {
        const amount = index / (faired.length - 1)
        faired[index] = {
          x: faired[index].x
            + startCorrection.x * (1 - amount) + endCorrection.x * amount,
          y: faired[index].y
            + startCorrection.y * (1 - amount) + endCorrection.y * amount
        }
      }
      samples.splice(0, samples.length, ...faired)
    }
    const cumulative = [0]
    for (let index = 1; index < samples.length; index += 1) {
      cumulative.push(cumulative[index - 1]
        + Math.hypot(samples[index].x - samples[index - 1].x,
          samples[index].y - samples[index - 1].y))
    }
    const totalPathLength = cumulative.at(-1)
    const pointAtDistance = fraction => {
      const wanted = Math.max(0, Math.min(1, fraction)) * totalPathLength
      let lo = 0
      let hi = cumulative.length - 1
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1
        if (cumulative[mid] < wanted) lo = mid
        else hi = mid
      }
      const span = Math.max(0.000001, cumulative[hi] - cumulative[lo])
      const amount = (wanted - cumulative[lo]) / span
      return {
        x: samples[lo].x + (samples[hi].x - samples[lo].x) * amount,
        y: samples[lo].y + (samples[hi].y - samples[lo].y) * amount
      }
    }
    const smoother = value => {
      const x = Math.max(0, Math.min(1, value))
      return x * x * x * (x * (x * 6 - 15) + 10)
    }
    const zoomAt = elapsed => {
      const t = Math.max(0, Math.min(config.durationMs, elapsed))
      if (t < 2_000) return 0.22
      if (t < 5_500) return 0.22 + (0.26 - 0.22) * smoother((t - 2_000) / 3_500)
      if (t < 16_500) return 0.26
      if (t < 19_000) return 0.26 + (0.80 - 0.26) * smoother((t - 16_500) / 2_500)
      if (t < 23_500) return 0.80
      if (t < 28_000) return 0.80 + (0.82 - 0.80) * smoother((t - 23_500) / 4_500)
      return 0.82 + (0.98 - 0.82) * smoother((t - 28_000) / 2_000)
    }

    const TRAVEL_END_MS = 28_000
    const TRAVEL_ACCEL_MS = 3_000
    const TRAVEL_DECEL_MS = 5_000
    const MOTION_SAMPLE_MS = 10
    const travelVelocity = elapsed => {
      const t = Math.max(0, Math.min(TRAVEL_END_MS, elapsed))
      const envelope = t < TRAVEL_ACCEL_MS
        ? smoother(t / TRAVEL_ACCEL_MS)
        : t > TRAVEL_END_MS - TRAVEL_DECEL_MS
          ? smoother((TRAVEL_END_MS - t) / TRAVEL_DECEL_MS)
          : 1
      // Ease down by twelve percent for the inhabited hero beat, then return
      // to cruise just as gradually. This gives the real residents and stone
      // paths time to read without a hold, cut, or discontinuity.
      const heroPace = t < 16_500 || t >= 23_500
        ? 1
        : t < 18_000
          ? 1 - 0.12 * smoother((t - 16_500) / 1_500)
          : t < 22_000
            ? 0.88
            : 0.88 + 0.12 * smoother((t - 22_000) / 1_500)
      return envelope * heroPace
    }
    // Integrate inverse zoom so the entire unbroken flight moves at a nearly
    // constant apparent speed. The floor prevents the 0.095 opener racing.
    const travelCumulative = [0]
    for (let t = MOTION_SAMPLE_MS; t <= TRAVEL_END_MS; t += MOTION_SAMPLE_MS) {
      const previous = t - MOTION_SAMPLE_MS
      const a = travelVelocity(previous) / Math.max(0.20, zoomAt(previous))
      const b = travelVelocity(t) / Math.max(0.20, zoomAt(t))
      travelCumulative.push(travelCumulative.at(-1) + (a + b) * MOTION_SAMPLE_MS * 0.5)
    }
    const totalTravelWeight = travelCumulative.at(-1)
    const travelFraction = elapsed => {
      const sample = Math.max(0, Math.min(TRAVEL_END_MS, elapsed)) / MOTION_SAMPLE_MS
      const lo = Math.floor(sample)
      const hi = Math.min(travelCumulative.length - 1, lo + 1)
      const amount = sample - lo
      const value = travelCumulative[lo]
        + (travelCumulative[hi] - travelCumulative[lo]) * amount
      return value / totalTravelWeight
    }

    // Pick a deterministic slice of the canonical wall-clock simulation in
    // which the hero village is genuinely active. This changes no routes or
    // speeds; it avoids presenting all six residents during authored dwell
    // phases in the only close-up window.
    const heroProbeTimes = []
    for (let time = 0; time <= config.durationMs; time += 200) {
      const probePosition = pointAtDistance(travelFraction(time))
      const probeZoom = zoomAt(time)
      const probeDistance = Math.hypot(
        stonefieldCenter.x - probePosition.x,
        stonefieldCenter.y - probePosition.y
      ) * probeZoom
      if (probeDistance < 500 && probeZoom >= 0.75 && time < 24_500) heroProbeTimes.push(time)
    }
    if (heroProbeTimes.length < 5) throw new Error('camera never establishes a resident simulation window')
    const fireflyWindowAt = candidate => {
      let minimumActive = Infinity
      let activeTotal = 0
      let luminanceTotal = 0
      let sampleCount = 0
      for (let time = 27_000; time <= config.durationMs; time += 250) {
        const seconds = (candidate + time) * 0.001
        let active = 0
        let luminance = 0
        for (let index = 0; index < 14; index += 1) {
          const seed = index * 37.7
          const pulse = Math.max(0, Math.sin(
            seconds * (0.55 + (index % 4) * 0.12) + seed * 3
          ))
          const alpha = pulse * pulse * pulse * 0.85
          if (alpha >= 0.03) active += 1
          luminance += alpha
        }
        minimumActive = Math.min(minimumActive, active)
        activeTotal += active
        luminanceTotal += luminance
        sampleCount += 1
      }
      return {
        minimumActive,
        averageActive: activeTotal / sampleCount,
        averageLuminance: luminanceTotal / sampleCount
      }
    }
    let simulationEpoch = AUTHORITY_EPOCH
    let selectedFireflyWindow = fireflyWindowAt(simulationEpoch)
    let bestResidentActivity = -Infinity
    for (let candidate = AUTHORITY_EPOCH;
      candidate <= AUTHORITY_EPOCH + 120_000;
      candidate += 1_000) {
      let traversers = 0
      let totalDistance = 0
      let movingSamples = 0
      const visibleBySample = heroProbeTimes.map(() => 0)
      for (const entity of stonefieldSim.entities) {
        const samples = heroProbeTimes.map(time => mapSystem.neighborLife.sample(entity, candidate + time))
        let distance = 0
        for (let index = 1; index < samples.length; index += 1) {
          distance += Math.hypot(
            samples[index].x - samples[index - 1].x,
            samples[index].y - samples[index - 1].y
          )
        }
        const moving = samples.filter(sample => sample.moving).length
        if (distance >= 0.75 && moving > 0) traversers += 1
        totalDistance += distance
        movingSamples += moving
        samples.forEach((sample, index) => {
          if (!mapSystem.neighborLife.occluded(stonefieldSim, sample.x, sample.y)) {
            visibleBySample[index] += 1
          }
        })
      }
      const fourVisibleSamples = visibleBySample.filter(count => count >= 4).length
      const minimumVisible = Math.min(...visibleBySample)
      const viable = traversers >= 2
        && fourVisibleSamples >= Math.max(3, Math.floor(heroProbeTimes.length * 0.4))
      const fireflies = fireflyWindowAt(candidate)
      // Keep the actual resident requirements absolute, then choose the most
      // luminous deterministic slice among viable moments. No fireflies are
      // added: this only selects a naturally busy instant from the shipped
      // 14-firefly simulation.
      const score = Number(viable) * 1_000_000_000
        + fireflies.minimumActive * 1_000_000
        + fireflies.averageActive * 10_000
        + fireflies.averageLuminance * 1_000
        + fourVisibleSamples * 100
        + traversers * 10
        + minimumVisible
        + movingSamples * 0.01
        + totalDistance
      if (score > bestResidentActivity) {
        bestResidentActivity = score
        simulationEpoch = candidate
        selectedFireflyWindow = fireflies
      }
    }

    const audit = {
      frames: 0,
      durationMs: config.durationMs,
      visibleFrames: Object.fromEntries(showcases.map(plot => [plot.key, 0])),
      featuredFrames: Object.fromEntries(showcases.map(plot => [plot.key, 0])),
      villageVisibleFrames: Object.fromEntries(villageTargets.map(target => [target.key, 0])),
      villageFeaturedFrames: Object.fromEntries(villageTargets.map(target => [target.key, 0])),
      roadSegmentVisibleFrames: Object.fromEntries(roadSegments.map(segment => [segment.key, 0])),
      villageRoadVisibleFrames: Object.fromEntries(villageTargets.map(target => [target.key, 0])),
      cloudWideFrames: 0,
      stonefieldCloseFrames: 0,
      stonefieldRoadCloseFrames: 0,
      stonefieldVisibleResidentPeak: 0,
      stonefieldFourResidentFrames: 0,
      stonefieldResidentMotion: {},
      deepNightCloseFrames: 0,
      minZoom: Infinity,
      maxZoom: -Infinity,
      maxScreenStep: 0,
      maxScreenStepAt: 0,
      maxZoomStep: 0,
      maxHeadingDeltaDegrees: 0,
      maxHeadingDeltaAt: 0,
      maxVectorAcceleration: 0,
      maxVectorAccelerationAt: 0,
      finalPhase: 0
    }
    let previousPose = null
    let previousVelocity = null
    let auditing = false
    const SIMULATION_EPOCH = simulationEpoch

    const applyPose = elapsed => {
      const t = Math.max(0, Math.min(config.durationMs, elapsed))
      const position = pointAtDistance(travelFraction(t))
      const zoom = zoomAt(t)

      const phase = t < 24_500
        ? 0.28
        : 0.28 + (0.9 - 0.28) * smoother((t - 24_500) / 4_000)
      const simTime = SIMULATION_EPOCH + t

      camera.setZoom(zoom)
      camera.centerOn(position.x, position.y)
      camera.preRender?.()
      dayNight.setPhaseOverride(phase)
      dayNight.strength = 1
      dayNight.update(simTime)
      dayNight.gradeOverlay?.setVisible(true)
      dayNight.nightLifeGfx?.setVisible(true)

      // The living frontier breathes on its authored 15 Hz clock. Static fog
      // was built from the widest camera cover, so no flight pose escapes it.
      mapSystem.drawFogEdge(simTime)
      mapSystem.fogStatic?.setVisible(true)
      mapSystem.fogEdge?.setVisible(true)

      const nightFactor = dayNight.nightFactor()
      // Postcard smoke, flags, wilderness animals/fireflies and villagers all
      // use the shipped update path. Pin its wall-clock sample to this exact
      // offline frame so residents cannot inherit render-machine timing.
      dayNight.constructor.serverOffsetMs = simTime - Date.now()
      mapSystem.updatePostcardLife(simTime)

      if (auditing) {
        audit.frames += 1
        audit.minZoom = Math.min(audit.minZoom, zoom)
        audit.maxZoom = Math.max(audit.maxZoom, zoom)
        audit.finalPhase = phase
        if (zoom <= 0.225) audit.cloudWideFrames += 1
        if (nightFactor >= 0.98 && zoom >= 0.75) audit.deepNightCloseFrames += 1
        if (previousPose) {
          const averageZoom = (zoom + previousPose.zoom) / 2
          const velocity = {
            x: (position.x - previousPose.x) * averageZoom,
            y: (position.y - previousPose.y) * averageZoom
          }
          const step = Math.hypot(velocity.x, velocity.y)
          if (step > audit.maxScreenStep) {
            audit.maxScreenStep = step
            audit.maxScreenStepAt = t
          }
          audit.maxZoomStep = Math.max(audit.maxZoomStep, Math.abs(zoom - previousPose.zoom))
          if (previousVelocity) {
            const previousStep = Math.hypot(previousVelocity.x, previousVelocity.y)
            if (step > 0.5 && previousStep > 0.5) {
              const cosine = (velocity.x * previousVelocity.x + velocity.y * previousVelocity.y)
                / (step * previousStep)
              const heading = Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI
              if (heading > audit.maxHeadingDeltaDegrees) {
                audit.maxHeadingDeltaDegrees = heading
                audit.maxHeadingDeltaAt = t
              }
            }
            const acceleration = Math.hypot(
              velocity.x - previousVelocity.x,
              velocity.y - previousVelocity.y
            )
            if (acceleration > audit.maxVectorAcceleration) {
              audit.maxVectorAcceleration = acceleration
              audit.maxVectorAccelerationAt = t
            }
          }
          previousVelocity = velocity
        }
        previousPose = { ...position, zoom }

        const stonefieldDistance = Math.hypot(
          stonefieldCenter.x - position.x,
          stonefieldCenter.y - position.y
        ) * zoom
        if (stonefieldDistance < 500 && zoom >= 0.75 && nightFactor < 0.1) {
          audit.stonefieldCloseFrames += 1
          const entities = stonefieldSim?.entities ?? []
          const visibleResidents = entities.filter(entity => entity.gfx?.visible).length
          audit.stonefieldVisibleResidentPeak = Math.max(
            audit.stonefieldVisibleResidentPeak,
            visibleResidents
          )
          if (visibleResidents >= 4) audit.stonefieldFourResidentFrames += 1
          const road = roadTargets.Stonefield
          const roadVisible = road.points.some(point =>
            Math.abs(point.x - position.x) * zoom < config.width / 2 - 80
            && Math.abs(point.y - position.y) * zoom < config.height / 2 - 80)
          if (roadVisible) {
            audit.stonefieldRoadCloseFrames += 1
          }
          for (let index = 0; index < entities.length; index += 1) {
            const entity = entities[index]
            const sample = mapSystem.neighborLife.sample(entity, simTime)
            if (!Number.isFinite(sample?.x) || !Number.isFinite(sample?.y)
              || sample.x < 0 || sample.x > 25 || sample.y < 0 || sample.y > 25) {
              throw new Error(`Stonefield resident ${index} sampled outside the simulated plot`)
            }
            const key = String(index)
            const stat = audit.stonefieldResidentMotion[key] ?? {
              role: entity.role,
              visibleFrames: 0,
              movingFrames: 0,
              distance: 0,
              maxStep: 0,
              lastX: sample.x,
              lastY: sample.y
            }
            const step = Math.hypot(sample.x - stat.lastX, sample.y - stat.lastY)
            stat.distance += step
            stat.maxStep = Math.max(stat.maxStep, step)
            stat.lastX = sample.x
            stat.lastY = sample.y
            if (entity.gfx?.visible) stat.visibleFrames += 1
            if (sample.moving) stat.movingFrames += 1
            audit.stonefieldResidentMotion[key] = stat
          }
        }
        for (const target of Object.values(targets)) {
          const sx = Math.abs(target.x - position.x) * zoom
          const sy = Math.abs(target.y - position.y) * zoom
          if (sx < config.width / 2 - 90 && sy < config.height / 2 - 70) {
            audit.visibleFrames[target.key] += 1
          }
          if (Math.hypot(target.x - position.x, target.y - position.y) * zoom < 560 && zoom >= 0.17) {
            audit.featuredFrames[target.key] += 1
          }
        }
        for (const target of villageTargets) {
          const sx = Math.abs(target.x - position.x) * zoom
          const sy = Math.abs(target.y - position.y) * zoom
          if (sx < config.width / 2 - 90 && sy < config.height / 2 - 70) {
            audit.villageVisibleFrames[target.key] += 1
          }
          if (Math.hypot(target.x - position.x, target.y - position.y) * zoom < 620 && zoom >= 0.17) {
            audit.villageFeaturedFrames[target.key] += 1
          }
          const road = roadTargets[target.key]
          const roadVisible = road.points.some(point =>
            Math.abs(point.x - position.x) * zoom < config.width / 2 - 80
            && Math.abs(point.y - position.y) * zoom < config.height / 2 - 80)
          if (zoom >= 0.18 && roadVisible) {
            audit.villageRoadVisibleFrames[target.key] += 1
          }
        }
        for (const road of roadSegments) {
          const sx = Math.abs(road.x - position.x) * zoom
          const sy = Math.abs(road.y - position.y) * zoom
          if (zoom >= 0.18 && sx < config.width / 2 - 80 && sy < config.height / 2 - 80) {
            audit.roadSegmentVisibleFrames[road.key] += 1
          }
        }
      }
    }

    // Build the shipped fog family at the exact even 10x10 boundary. Ordinary
    // sight radii are odd squares, so the capture uses the same private floor,
    // bank and living-edge painters with an explicit rectangular bound.
    camera.centerOn(fogCenter.x, fogCenter.y)
    camera.setZoom(0.095)
    camera.preRender?.()
    mapSystem.fogStatic?.destroy()
    mapSystem.fogEdge?.destroy()
    mapSystem.fogStatic = null
    mapSystem.fogEdge = null
    mapSystem.fogStaticCover = null
    mapSystem.fogReveal = null
    mapSystem.fogRevealBoundary = { ...config.fogBound }
    mapSystem.fogRadius = -1
    mapSystem.nextFogEdgeAt = 0
    const fogStatic = scene.add.graphics().setDepth(28_500)
    mapSystem.paintFogFloor(fogStatic, config.fogBound)
    const fogCover = mapSystem.fogCoverRect(700)
    mapSystem.paintFogBank(fogStatic, config.fogBound, fogCover)
    mapSystem.fogStatic = fogStatic
    mapSystem.fogStaticCover = fogCover
    dayNight.setSightBound?.({ ...config.fogBound })
    mapSystem.drawFogEdge(SIMULATION_EPOCH)

    // Re-enable only the two real night layers hidden with the live scene.
    dayNight.gradeOverlay?.setVisible(true)
    dayNight.nightLifeGfx?.setVisible(true)

    window.__wildernessFlight = {
      durationMs: config.durationMs,
      audit,
      beginCapture() {
        auditing = true
        previousPose = null
        previousVelocity = null
        audit.frames = 0
        audit.visibleFrames = Object.fromEntries(showcases.map(plot => [plot.key, 0]))
        audit.featuredFrames = Object.fromEntries(showcases.map(plot => [plot.key, 0]))
        audit.villageVisibleFrames = Object.fromEntries(villageTargets.map(target => [target.key, 0]))
        audit.villageFeaturedFrames = Object.fromEntries(villageTargets.map(target => [target.key, 0]))
        audit.roadSegmentVisibleFrames = Object.fromEntries(roadSegments.map(segment => [segment.key, 0]))
        audit.villageRoadVisibleFrames = Object.fromEntries(villageTargets.map(target => [target.key, 0]))
        audit.cloudWideFrames = 0
        audit.stonefieldCloseFrames = 0
        audit.stonefieldRoadCloseFrames = 0
        audit.stonefieldVisibleResidentPeak = 0
        audit.stonefieldFourResidentFrames = 0
        audit.stonefieldResidentMotion = {}
        audit.deepNightCloseFrames = 0
        audit.minZoom = Infinity
        audit.maxZoom = -Infinity
        audit.maxScreenStep = 0
        audit.maxScreenStepAt = 0
        audit.maxZoomStep = 0
        audit.maxHeadingDeltaDegrees = 0
        audit.maxHeadingDeltaAt = 0
        audit.maxVectorAcceleration = 0
        audit.maxVectorAccelerationAt = 0
        mapSystem.nextLifeDrawAt = 0
      },
      async seek(elapsed) {
        applyPose(elapsed)
        // Two browser frames make the camera's worldView, the paused Phaser
        // scene render, and the compositor agree before the PNG is read back.
        // This is also resilient to a game-level postrender event being
        // skipped while DevTools briefly throttles the headless page.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      },
      report: {
        seedVersion,
        simulationEpoch: SIMULATION_EPOCH,
        fireflyWindow: selectedFireflyWindow,
        atlas: {
          columns: config.atlasMax - config.atlasMin + 1,
          rows: config.atlasMax - config.atlasMin + 1,
          minOffset: config.atlasMin,
          maxOffset: config.atlasMax,
          contiguous: true,
          worldCenter: country.center
        },
        occupancy: {
          mode: 'cinematic-curation',
          productionFrontierSnapshot: false,
          note: 'Real coordinate ecology, production village layouts, resident simulation, and road renderers arranged at trailer density.'
        },
        fogBound: config.fogBound,
        archetypes: showcases.map((plot, index) => ({
          index,
          key: plot.key,
          label: plot.label,
          coordinate: { x: plot.x, y: plot.y },
          atlas: { dx: plot.dx, dy: plot.dy },
          revision: archetypeViewByKey.get(plot.key)?.renderedRevision ?? null,
          hydrology: plot.hydrology,
          hydrologyFeatures: plot.hydrologyFeatures
        })),
        villages: villageRecords.map((record, index) => ({
          index,
          name: record.site.name,
          source: record.source,
          difficulty: record.difficulty,
          seed: record.seed,
          ownerId: record.world.ownerId,
          generatedUsername: record.source === 'generated' ? record.world.username : null,
          generatorVersion: record.generatorVersion,
          atlas: { dx: record.site.dx, dy: record.site.dy },
          buildingCount: record.world.buildings.length,
          buildingTypes: record.world.buildings.map(building => building.type),
          levels: [...new Set(record.world.buildings.map(building => building.level))].sort((a, b) => a - b),
          maximumBuildingLevel: Math.max(...record.world.buildings.map(building => building.level)),
          wallLevel: record.world.wallLevel,
          wallCount: record.world.buildings.filter(building => building.type === 'wall').length,
          armyCampLevels: record.world.buildings
            .filter(building => building.type === 'army_camp')
            .map(building => building.level)
            .sort((a, b) => a - b),
          population: record.population,
          youngResidents: record.world.life.bornAt.length,
          simulatedThrough: record.world.life.simulatedThrough,
          banner: record.world.banner,
          sourceStoneMaturity: record.plot.stoneMaturity,
          renderedStoneMaturity: record.plot.kind === 'bot' ? 1 : record.plot.stoneMaturity,
          stoneRouteCount: record.stoneRoutes.length,
          residentsRegistered: record.view.residentsRegistered
        })),
        futureVillage: {
          key: 'meadow',
          label: targets.meadow.label,
          atlas: { dx: 0, dy: 0 },
          coordinate: { ...country.center },
          plotCentre: { x: meadowCenter.x, y: meadowCenter.y },
          landing: { x: meadowLanding.x, y: meadowLanding.y },
          settleable: true
        },
        renderedViews: allViews.length,
        natureViews: natureViews.length,
        villageViews: villageViews.length,
        totalPostcardPopulation: villageRecords.reduce((sum, record) => sum + record.population, 0),
        roadNetwork: {
          staticLayerActive: Boolean(mapSystem.wilderness?.active && mapSystem.wilderness?.visible),
          staticCommandCount: mapSystem.wilderness?.commandBuffer?.length ?? 0,
          linkCommandCount: mapSystem.wildernessLinks?.commandBuffer?.length ?? 0,
          gapCommandCount: mapSystem.wildernessGapSurface?.commandBuffer?.length ?? 0,
          roadSegmentCount: roadSegments.length,
          joinedVerticalCount: atlasTopology.verticalJoins.length,
          joinedHorizontalCount: atlasTopology.horizontalJoins.length,
          adjacentVillageRoads,
          settlementClusterCount,
          futureVillageRoadFree,
          servicedVillages
        },
        fillerPlots: fillers.map((plot, index) => ({
          index,
          key: plot.key,
          label: plot.label,
          coordinate: { x: plot.x, y: plot.y },
          atlas: { dx: plot.dx, dy: plot.dy },
          revision: fillerViews[index].renderedRevision
        })),
        splineKnots: routeControls,
        splineLength: totalPathLength
      }
    }

    mapSystem.nextRefreshAt = Number.POSITIVE_INFINITY
    mapSystem.update = () => {}
    applyPose(0)
    scene.scene.pause()
    return window.__wildernessFlight.report
  }, {
    archetypeKeys: ARCHETYPE_KEYS,
    villages: VILLAGE_SITES,
    pitch: PLOT_PITCH,
    tiles: PLOT_TILES,
    atlasMin: ATLAS_MIN,
    atlasMax: ATLAS_MAX,
    fogBound: FOG_BOUND,
    durationMs: DURATION_MS,
    searchRadius: SEARCH_RADIUS,
    width: WIDTH,
    height: HEIGHT
  })
}

function ffmpegArguments(outputPath) {
  const seconds = DURATION_MS / 1_000
  const fadeOutAt = Math.max(0, seconds - 1.8)
  return [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-f', 'image2pipe', '-framerate', String(FPS), '-vcodec', 'png', '-i', 'pipe:0',
    '-stream_loop', '-1', '-i', MUSIC,
    '-filter_complex',
    `[1:a]atrim=0:${seconds},asetpts=N/SR/TB,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutAt}:d=1.8,loudnorm=I=-21:LRA=7:TP=-1.5[a]`,
    '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '15', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-movflags', '+faststart',
    '-c:a', 'aac', '-ar', '48000', '-b:a', '192k', '-shortest', outputPath
  ]
}

let browser = null
try {
  let cachedToken = null
  try { cachedToken = JSON.parse(readFileSync(TOKEN_CACHE, 'utf8')).token ?? null } catch { /* mint below */ }
  let session = await api('POST', '/auth/session', { body: cachedToken ? { token: cachedToken } : {} })
  if (session.status !== 200 || !session.json?.token) {
    // A token cache can outlive an isolated capture server. Retry once without
    // it so a fresh disposable server may mint the trailer identity.
    session = await api('POST', '/auth/session', { body: {} })
  }
  assert(session.status === 200 && session.json?.token,
    `auth/session failed (${session.status}): ${session.raw}`)
  const token = session.json.token
  try { writeFileSync(TOKEN_CACHE, JSON.stringify({ token })) } catch { /* non-fatal */ }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--use-gl=swiftshader',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      `--window-size=${WIDTH},${HEIGHT}`
    ]
  })
  const page = await browser.newPage()
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 })
  const errors = []
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('error', error => errors.push(`page crash: ${error.message}`))
  await page.evaluateOnNewDocument(value => localStorage.setItem('clash.device.token', value), token)
  await page.goto(`${BASE}/game`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.keys?.MainScene
    return Boolean(scene?.worldMap && scene?.dayNight && scene?.cameras?.main && scene?.buildings?.length)
  }, { timeout: 60_000, polling: 300 })
  await page.waitForSelector('.cloud-overlay', { hidden: true, timeout: 20_000 }).catch(() => {})
  await resolveBannerGate(page)
  await page.addStyleTag({ content: `
    html, body, #root, .app-container, #game-container { margin: 0 !important; width: 100% !important; height: 100% !important; overflow: hidden !important; }
    .app-container > :not(#game-container) { opacity: 0 !important; pointer-events: none !important; }
    .village-bubble-layer, .plot-bubble, .building-bubble { display: none !important; }
  ` })

  const coverage = await prepareFlight(page)
  assert(coverage.renderedViews === 100,
    `world country has ${coverage.renderedViews} views instead of 100`)
  assert(coverage.atlas.columns === 10 && coverage.atlas.rows === 10,
    `atlas is ${coverage.atlas.columns}x${coverage.atlas.rows} instead of 10x10`)
  assert(coverage.atlas.contiguous,
    'country atlas rearranged unrelated source plots instead of using one contiguous window')
  assert(coverage.archetypes.length === 11,
    `coverage report has ${coverage.archetypes.length} archetypes instead of 11`)
  assert(new Set(coverage.archetypes.map(item => item.key)).size === 11,
    'coverage report contains duplicate archetypes')
  assert(coverage.villages.length === VILLAGE_SITES.length,
    `country has ${coverage.villages.length} villages instead of ${VILLAGE_SITES.length}`)
  const starterVillages = coverage.villages.filter(village => village.source === 'starter')
  const generatedVillages = coverage.villages.filter(village => village.source === 'generated')
  const highVillageBands = new Set(['elite', 'fortress', 'extreme'])
  const fortressBands = new Set(['fortress', 'extreme'])
  assert(starterVillages.length === 4
    && starterVillages.every(village => village.levels.length === 1 && village.levels[0] === 1),
  'the north-west starter cluster is not four genuine level-one villages')
  assert(generatedVillages.length === 8
    && generatedVillages.every(village => village.generatorVersion !== null
      && Number.isSafeInteger(village.seed)
      && village.maximumBuildingLevel > 1),
  'one or more mature villages did not come from the production procedural generator')
  assert(generatedVillages.filter(village => highVillageBands.has(village.difficulty)).length >= 4
    && generatedVillages.filter(village => fortressBands.has(village.difficulty)).length >= 2,
  `country lacks enough elite/fortress variety: ${JSON.stringify(generatedVillages.map(village => village.difficulty))}`)
  assert(generatedVillages.every(village => village.wallCount > 0 && village.wallLevel >= 1),
    'one or more mature villages lacks its generated wall complex')
  assert(coverage.villages.every(village => village.residentsRegistered && village.population >= 1),
    'one or more scattered villages is missing its postcard population')
  assert(coverage.villages.every(village => village.stoneRouteCount >= 2),
    'one or more scattered villages lacks canonical town-hall stone routes')
  assert(starterVillages.every(village => village.sourceStoneMaturity >= (village.population - 3) / 3),
    'population and server-aged paving maturity are inconsistent')
  assert(coverage.villages.every(village => Math.max(Math.abs(village.atlas.dx), Math.abs(village.atlas.dy)) >= 2),
    'a populated village crowds the untouched destination meadow')
  assert(coverage.futureVillage.key === 'meadow' && coverage.futureVillage.settleable,
    'future-village meadow is not staged as settleable')
  assert(coverage.roadNetwork.staticLayerActive
    && coverage.roadNetwork.staticCommandCount > 1_000
    && coverage.roadNetwork.roadSegmentCount >= 12,
  'production country-road atlas is absent or incomplete')
  assert(Object.values(coverage.roadNetwork.servicedVillages).every(edges => edges.length === 4),
    'one or more villages is not serviced on all four road edges')
  assert(coverage.roadNetwork.adjacentVillageRoads.length >= 8
    && coverage.roadNetwork.settlementClusterCount <= 3,
  'tiered villages are not grouped into a convincing canonical road network')
  assert(coverage.roadNetwork.futureVillageRoadFree,
    'future-village meadow is not completely reclaimed to wilderness grass')
  assert(coverage.fireflyWindow.minimumActive >= 6
    && coverage.fireflyWindow.averageActive >= 10,
  `selected night moment is too sparse (${JSON.stringify(coverage.fireflyWindow)})`)

  // Let the RenderTextures finish their point-sampling and quantization pass.
  await page.evaluate(() => window.__wildernessFlight.seek(0))
  await sleep(800)
  assert(errors.length === 0, `browser errors during gallery preparation:\n${errors.join('\n')}`)

  const outputPath = `${OUT}/${OUTPUT_NAME}.mp4`
  const encoder = spawn(FFMPEG, ffmpegArguments(outputPath), { stdio: ['pipe', 'ignore', 'pipe'] })
  let encoderLog = ''
  encoder.stderr.on('data', chunk => { encoderLog += chunk.toString() })
  const frameCount = Math.round(DURATION_MS / 1_000 * FPS)
  const captureStartedAt = Date.now()
  await page.evaluate(() => window.__wildernessFlight.beginCapture())

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const elapsed = frameIndex * 1_000 / FPS
    await page.evaluate(time => window.__wildernessFlight.seek(time), elapsed)
    const png = await page.screenshot({ type: 'png', captureBeyondViewport: false })
    if (!encoder.stdin.write(png)) await once(encoder.stdin, 'drain')
    if (frameIndex % Math.max(1, FPS * 2) === 0) {
      const percent = ((frameIndex + 1) / frameCount * 100).toFixed(1)
      console.log(`rendered ${frameIndex + 1}/${frameCount} frames (${percent}%)`)
    }
  }
  encoder.stdin.end()
  const [encoderCode, encoderSignal] = await once(encoder, 'close')
  assert(encoderCode === 0,
    `ffmpeg failed (code=${encoderCode}, signal=${encoderSignal}):\n${encoderLog}`)

  const result = await page.evaluate(() => ({
    audit: window.__wildernessFlight.audit,
    report: window.__wildernessFlight.report,
    canvas: {
      width: document.querySelector('#game-container canvas')?.width,
      height: document.querySelector('#game-container canvas')?.height
    }
  }))
  const underexposed = Object.entries(result.audit.visibleFrames)
    .filter(([, frames]) => frames < FPS * 2)
    .map(([key, frames]) => ({ key, frames }))
  const unfeatured = Object.entries(result.audit.featuredFrames)
    .filter(([, frames]) => frames < Math.max(1, Math.floor(FPS / 4)))
    .map(([key, frames]) => ({ key, frames }))
  const unseenVillages = Object.entries(result.audit.villageVisibleFrames)
    .filter(([, frames]) => frames < FPS * 2)
    .map(([name, frames]) => ({ name, frames }))
  const featuredVillageCount = Object.values(result.audit.villageFeaturedFrames)
    .filter(frames => frames >= Math.max(3, Math.floor(FPS / 2))).length
  const visibleRoadSegmentCount = Object.values(result.audit.roadSegmentVisibleFrames)
    .filter(frames => frames >= Math.max(1, Math.floor(FPS / 2))).length
  const unseenVillageRoads = Object.entries(result.audit.villageRoadVisibleFrames)
    .filter(([, frames]) => frames < Math.max(1, Math.floor(FPS / 2)))
    .map(([name, frames]) => ({ name, frames }))
  const movingResidents = Object.values(result.audit.stonefieldResidentMotion)
    .filter(stat => stat.movingFrames >= Math.max(1, Math.floor(FPS / 2))
      && stat.distance >= 0.75 && stat.maxStep * FPS / 24 <= 0.2)
  assert(underexposed.length === 0,
    `camera did not visibly include every archetype: ${JSON.stringify(underexposed)}`)
  assert(unfeatured.length === 0,
    `camera did not give every archetype a close flyover: ${JSON.stringify(unfeatured)}`)
  assert(unseenVillages.length === 0,
    `camera did not visibly include every tiered village: ${JSON.stringify(unseenVillages)}`)
  assert(featuredVillageCount >= 8,
    `camera closely featured only ${featuredVillageCount} of ${coverage.villages.length} villages`)
  assert(visibleRoadSegmentCount >= 4,
    `camera clearly exposed only ${visibleRoadSegmentCount} village-serving road segments`)
  assert(unseenVillageRoads.length === 0,
    `camera missed one or more village frontage roads: ${JSON.stringify(unseenVillageRoads)}`)
  assert(result.audit.cloudWideFrames >= FPS * 2,
    `cloud-bank entry was visible too briefly (${result.audit.cloudWideFrames} frames)`)
  assert(result.audit.stonefieldCloseFrames >= FPS * 2.5,
    `Stonefield villagers were featured too briefly (${result.audit.stonefieldCloseFrames} frames)`)
  assert(result.audit.stonefieldRoadCloseFrames >= result.audit.stonefieldCloseFrames * 0.9,
    `Stonefield frontage road left frame during its hero pass (${result.audit.stonefieldRoadCloseFrames}/${result.audit.stonefieldCloseFrames})`)
  assert(result.audit.stonefieldVisibleResidentPeak >= 3,
    `only ${result.audit.stonefieldVisibleResidentPeak} Stonefield residents were visibly staged`)
  assert(result.audit.stonefieldFourResidentFrames >= FPS,
    `four Stonefield residents were visible together for only ${result.audit.stonefieldFourResidentFrames} frames`)
  assert(movingResidents.length >= 2,
    `only ${movingResidents.length} Stonefield residents visibly traversed valid simulated routes: ${JSON.stringify(result.audit.stonefieldResidentMotion)}`)
  assert(result.audit.deepNightCloseFrames >= FPS * 1.5,
    `night meadow/firefly ending was too brief (${result.audit.deepNightCloseFrames} frames)`)
  // Preview renders can intentionally use a lower FPS; normalize their
  // per-frame displacement to the 60 fps delivery cadence before judging it.
  assert(result.audit.maxScreenStep * FPS / 60 < 8.5,
    `camera exceeded smooth-motion threshold (${result.audit.maxScreenStep.toFixed(2)} px/frame at ${FPS} fps, ${result.audit.maxScreenStepAt.toFixed(0)} ms)`)
  assert(result.audit.maxZoomStep * FPS / 60 < 0.01,
    `camera zoom exceeded smooth-motion threshold (${result.audit.maxZoomStep.toFixed(5)} per frame at ${FPS} fps)`)
  assert(result.audit.maxHeadingDeltaDegrees * FPS / 60 < 2.7,
    `camera exceeded smooth-turn threshold (${result.audit.maxHeadingDeltaDegrees.toFixed(2)}° at ${FPS} fps, ${result.audit.maxHeadingDeltaAt.toFixed(0)} ms)`)
  assert(result.audit.maxVectorAcceleration * (FPS / 60) ** 2 < 0.35,
    `camera exceeded smooth-acceleration threshold (${result.audit.maxVectorAcceleration.toFixed(2)} px/frame² at ${FPS} fps, ${result.audit.maxVectorAccelerationAt.toFixed(0)} ms)`)
  assert(result.canvas.width === WIDTH && result.canvas.height === HEIGHT,
    `canvas was ${result.canvas.width}x${result.canvas.height}, expected ${WIDTH}x${HEIGHT}`)
  assert(errors.length === 0, `browser errors during capture:\n${errors.join('\n')}`)

  const finalReport = {
    durationSeconds: DURATION_MS / 1_000,
    renderSeconds: (Date.now() - captureStartedAt) / 1_000,
    output: outputPath,
    frames: frameCount,
    fps: FPS,
    canvas: result.canvas,
    cameraAudit: result.audit,
    coverage,
    browserErrors: errors
  }
  writeFileSync(`${OUT}/${OUTPUT_NAME}-report.json`, JSON.stringify(finalReport, null, 2))
  console.log('wilderness flight coverage', JSON.stringify(coverage, null, 2))
  console.log('camera audit', JSON.stringify(result.audit))
  console.log(`rendered ${OUTPUT_NAME}.mp4: ${frameCount} unique frames at ${FPS} fps`)
} finally {
  await browser?.close()
}
