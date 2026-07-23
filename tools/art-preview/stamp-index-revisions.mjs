#!/usr/bin/env node
// Stamp a per-unit content revision into public/assets/sprites/index.json.
//
// WHY: production serves everything under /assets/sprites/<kind>/<unit>/ with
// a one-year immutable cache (vercel.json). The client busts those URLs with
// `?v=<hash of index.json text>` (SpriteBank.indexRevision) — which only
// works if a rebake CHANGES the index text. Entries carry no content stamp,
// so rebakes shipped byte-identical indexes and returning players kept
// year-old sprites (the 2026-07-23 dragons_breath incident). This stamp makes
// any change to a unit's manifest/atlas flip its `rev`, which flips the index
// text, which flips every unit URL.
//
// Run after ANY bake or pack (bake-sprites.mjs and pack-atlases.mjs both
// invoke this automatically at exit). Idempotent: unchanged art -> unchanged
// revs -> unchanged index -> warm caches stay warm.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SPRITES = path.join(ROOT, 'public', 'assets', 'sprites')
const INDEX = path.join(SPRITES, 'index.json')

const index = JSON.parse(readFileSync(INDEX, 'utf8'))
let changed = 0
for (const unit of index.units) {
    const h = createHash('sha1')
    for (const rel of [unit.manifest, unit.frames, unit.atlas]) {
        try {
            h.update(readFileSync(path.join(SPRITES, rel)))
        } catch {
            h.update(`missing:${rel}`)
        }
    }
    const rev = h.digest('hex').slice(0, 10)
    if (unit.rev !== rev) {
        unit.rev = rev
        changed++
    }
}
writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n')
console.log(`stamp-index-revisions: ${index.units.length} units, ${changed} rev(s) updated`)
