import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'

const spriteRoot = new URL('../public/assets/sprites/', import.meta.url)
const [index, bankSource, sceneSource] = await Promise.all([
  readFile(new URL('index.json', spriteRoot), 'utf8').then(JSON.parse),
  readFile(new URL('../src/game/render/SpriteBank.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/scenes/MainScene.ts', import.meta.url), 'utf8')
])

const homeVillagers = [
  'bird_dove', 'bird_heron', 'bird_sparrow', 'chicken', 'dog', 'dragon',
  'merchant', 'owl', 'stall', 'thief', 'villager'
].map(unit => `villagers:${unit}`)
const homeFigures = [
  'caravan_soldier', 'fish', 'traveller_courier', 'traveller_hunter',
  'traveller_marketgoer', 'traveller_monk', 'traveller_patrol',
  'traveller_shepherd', 'traveller_wanderer', 'traveller_woodcutter'
].map(unit => `figures:${unit}`)
const starterKeys = new Set([
  ...homeVillagers,
  ...homeFigures,
  ...['grass_patch', 'rock_large', 'rock_small', 'tree_oak', 'tree_pine'].map(unit => `obstacles:${unit}`),
  'buildings:town_hall',
  'buildings:army_camp',
  'buildings:mine'
])

const unitKey = unit => `${unit.kind}:${unit.unit}`
const starterUnits = index.units.filter(unit => starterKeys.has(unitKey(unit)))
assert.equal(starterUnits.length, starterKeys.size,
  'Every starter/home-life requirement must resolve to a packed sprite unit')

const unitBytes = async unit => {
  const files = [unit.atlas, unit.frames, unit.manifest]
  return (await Promise.all(files.map(file => stat(new URL(file, spriteRoot))))).reduce((sum, file) => sum + file.size, 0)
}
const indexBytes = (await stat(new URL('index.json', spriteRoot))).size
const starterBytes = indexBytes + (await Promise.all(starterUnits.map(unitBytes))).reduce((sum, bytes) => sum + bytes, 0)
const fullBytes = indexBytes + (await Promise.all(index.units.map(unitBytes))).reduce((sum, bytes) => sum + bytes, 0)
const starterRequests = 1 + starterUnits.length * 3
const fullRequests = 1 + index.units.length * 3

assert.ok(starterRequests <= 90,
  `Starter reveal budget regressed to ${starterRequests} requests`)
assert.ok(starterBytes <= 2.75 * 1024 * 1024,
  `Starter reveal budget regressed to ${(starterBytes / 1024 / 1024).toFixed(2)} MiB`)
assert.match(bankSource, /for \(let offset = 0; offset < keys\.length; offset \+= 2\)/,
  'Background loading must remain interruptible in two-unit batches')
assert.match(sceneSource, /SpriteBank\.ensureBootUnits\(this, requirements\)/,
  'Home reveal must explicitly await its hydrated sprite inventory')
assert.match(sceneSource, /SpriteBank\.ensureUnits\(this, battleSpriteRequirements\(/,
  'Battle entry must explicitly await target, army, wreck, and projectile art')

console.log(JSON.stringify({
  status: 'ok',
  full: { units: index.units.length, requests: fullRequests, MiB: +(fullBytes / 1024 / 1024).toFixed(2) },
  starter: { units: starterUnits.length, requests: starterRequests, MiB: +(starterBytes / 1024 / 1024).toFixed(2) },
  reduction: {
    requestsPct: +((1 - starterRequests / fullRequests) * 100).toFixed(1),
    bytesPct: +((1 - starterBytes / fullBytes) * 100).toFixed(1)
  }
}))
