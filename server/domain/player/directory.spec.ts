import assert from 'node:assert/strict'
import { PlayerDirectory } from './directory'

const directory = new PlayerDirectory()
assert.equal(directory.add('a'), true)
assert.equal(directory.add('b'), true)
assert.equal(directory.add('c'), true)
assert.equal(directory.add('a'), false)
assert.equal(directory.size, 3)
assert.deepEqual(directory.probe({ random: () => 0, exclude: 'a' }), ['b', 'c'])
assert.deepEqual(directory.probe({ random: () => 0.34, limit: 2 }), ['b', 'c'])
assert.equal(directory.remove('b'), true)
assert.equal(directory.remove('missing'), false)
assert.equal(directory.has('b'), false)
assert.equal(directory.has('c'), true)
assert.deepEqual(new Set(directory.probe({ limit: 10, random: () => 0 })), new Set(['a', 'c']))

const mass = new PlayerDirectory()
for (let index = 0; index < 100_000; index += 1) mass.add(`player_${index}`)
const bounded = mass.probe({ exclude: 'player_50000', limit: 2_048, random: () => 0.5 })
assert.equal(bounded.length, 2_048)
assert.equal(bounded.includes('player_50000'), false)
assert.equal(mass.size, 100_000)

console.log('player directory: bounded dense selection passed')
