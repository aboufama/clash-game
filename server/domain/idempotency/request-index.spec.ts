import assert from 'node:assert/strict'
import { RequestReplayIndex } from './request-index'

const index = new RequestReplayIndex({ ttlMs: 100, maximumEntries: 2 })
index.set('attack', 'p1', 'r1', 'a1', 0)
assert.equal(index.get('attack', 'p1', 'r1', 50), 'a1')
index.set('attack', 'p1', 'r1', 'replacement', 60)
assert.equal(index.get('attack', 'p1', 'r1', 70), 'a1', 'first claim wins')
index.set('attack', 'p1', 'r2', 'a2', 10)
index.set('attack', 'p1', 'r3', 'a3', 20)
assert.equal(index.get('attack', 'p1', 'r1', 30), undefined, 'capacity evicts oldest')
assert.equal(index.get('attack', 'p1', 'r2', 111), undefined, 'TTL expires markers')
assert.equal(index.get('attack', 'p1', 'r3', 50), 'a3')

console.log('request replay index: bounded O(1) idempotency lookup passed')
