#!/usr/bin/env node
// Fetch the RuneScape soundtrack selection for the game's music system.
//
// Queries the Old School RuneScape wiki (MediaWiki API) for each candidate
// track's OGG file, downloads the ones that exist into
// public/assets/audio/music/, and writes manifest.json mapping every track to
// a music context (home / world / battle / night / title / victory / defeat /
// jingle). Rerunnable: existing files are kept unless --force.
//
// Music is Jagex IP — personal, non-commercial fan use only.

import { mkdir, writeFile, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'audio', 'music')
const API = 'https://oldschool.runescape.wiki/api.php'
const UA = 'clash-game-personal-fan-project/1.0 (non-commercial hobby use)'
const FORCE = process.argv.includes('--force')

// Candidate track names per context (wiki File: page names, without .ogg).
// Misses are reported, not fatal — names get curated by rerunning.
const CANDIDATES = {
  home: [
    'Harmony', 'Autumn Voyage', 'Book of Spells', 'Garden', 'Flute Salad',
    'Yesteryear', 'Medieval', 'Dream', 'Baroque', 'Greatness',
    'Home Sweet Home', 'Harmony 2', 'Parade',
  ],
  world: [
    'Sea Shanty 2', 'Wander', 'Adventure', 'Horizon', 'Expanse',
    'Newbie Melody', 'Spirit', 'Voyage', 'Wild Side', 'Al Kharid',
    'Long Way Home', 'Camelot', 'Wilderness', 'Overture',
  ],
  battle: [
    'Attention', 'Army of Darkness', 'Inferno', 'TzHaar!',
    'Head to Head', 'Dogs of War', 'Warpath', 'Victory is Mine',
    'Fire and Brimstone', 'Scape Wild', 'Barbarianism', 'Warrior',
    'Complication', 'Faithless',
  ],
  night: [
    'Lullaby', 'Nightfall', 'Moody', 'Starlight', 'Serenade', 'Still Night',
  ],
  title: ['Scape Main', 'Scape Original'],
  victory: ['Fanfare', 'Fanfare 2', 'Fanfare 3'],
  defeat: ['Forever', 'Tears of Guthix'],
  // Short stingers (a few seconds each) for one-shot game events.
  jingle_reveal: [
    'First Sunshine (Death to the Dorgeshuun)', 'Treasure! (Treasure Trails)',
    'Star of Your Own (Shooting Stars)', 'Dream World (Lunar Diplomacy)',
  ],
  jingle_build: [
    'Construction Level Up!', 'Smithing Level Up!', 'Crafting Level Up!',
  ],
  jingle_victory: [
    'Quest Complete 1', 'Quest Complete 2', 'Quest Complete 3',
    'Victory! (Castle Wars)', 'Honourable Victory! (Barbarian Assault)',
    'Last Man Standing! (Fight Pits)', "You Are Victorious! (Emir's Arena)",
  ],
  jingle_defeat: [
    'Slaughtered... (Castle Wars)', 'Defeated! (Soul Wars)', 'Oh Dear!',
    'Void Knight Defeated... (Pest Control)',
  ],
  jingle_loot: [
    'Grave Robber (Barrows)', 'Rune Casket Open! (Rouge Trader)',
  ],
}

const slugify = (name) =>
  name.toLowerCase().replace(/['!]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

async function api(params) {
  const url = `${API}?${new URLSearchParams({ format: 'json', ...params })}`
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`API ${res.status} for ${url}`)
  return res.json()
}

// Resolve file info for a batch of titles (<=50 per API call).
async function resolveBatch(titles) {
  const data = await api({
    action: 'query',
    titles: titles.map((t) => `File:${t}.ogg`).join('|'),
    prop: 'imageinfo',
    iiprop: 'url|size',
  })
  const found = new Map()
  const normalized = data.query?.normalized ?? []
  const denorm = new Map(normalized.map((n) => [n.to, n.from]))
  for (const page of Object.values(data.query?.pages ?? {})) {
    const info = page.imageinfo?.[0]
    if (!info || page.missing !== undefined) continue
    const title = denorm.get(page.title) ?? page.title
    const name = title.replace(/^File:/, '').replace(/\.ogg$/, '')
    found.set(name, { url: info.url, bytes: info.size, duration: info.duration ?? null })
  }
  return found
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) throw new Error(`download ${res.status} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })

  const all = Object.entries(CANDIDATES).flatMap(([context, names]) =>
    names.map((name) => ({ context, name })),
  )
  const infoByName = new Map()
  const uniqueNames = [...new Set(all.map((t) => t.name))]
  for (let i = 0; i < uniqueNames.length; i += 50) {
    const batch = uniqueNames.slice(i, i + 50)
    const found = await resolveBatch(batch)
    for (const [name, info] of found) infoByName.set(name, info)
  }

  const tracks = []
  const missing = []
  let queue = all.slice()
  const workers = Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const { context, name } = queue.shift()
      const info = infoByName.get(name)
      if (!info) { missing.push({ context, name }); continue }
      const slug = slugify(name)
      const file = `${slug}.ogg`
      const dest = path.join(OUT_DIR, file)
      const exists = await stat(dest).then((s) => s.size > 0, () => false)
      if (!exists || FORCE) {
        try {
          await download(info.url, dest)
          console.log(`  ✓ ${context.padEnd(7)} ${name} (${(info.bytes / 1e6).toFixed(1)} MB)`)
        } catch (err) {
          console.log(`  ✗ ${context.padEnd(7)} ${name} — ${err.message}`)
          missing.push({ context, name })
          continue
        }
      } else {
        console.log(`  = ${context.padEnd(7)} ${name} (cached)`)
      }
      tracks.push({
        name, slug, file, context,
        duration: info.duration ? Math.round(info.duration * 10) / 10 : null,
        bytes: info.bytes,
        source: info.url.split('?')[0],
      })
    }
  })
  await Promise.all(workers)

  tracks.sort((a, b) => a.context.localeCompare(b.context) || a.name.localeCompare(b.name))
  const manifest = {
    attribution: 'Music © Jagex Ltd (RuneScape / Old School RuneScape). Personal non-commercial fan use.',
    tracks,
  }
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))

  console.log(`\n${tracks.length} tracks in manifest, ${missing.length} candidates missing.`)
  if (missing.length) {
    console.log('Missing (name not on wiki — curate and rerun):')
    for (const m of missing) console.log(`  - [${m.context}] ${m.name}`)
  }

  // Discovery aid: list short jingle/fanfare files on the wiki so the
  // candidate list can be curated with real names.
  for (const term of ['jingle', 'fanfare']) {
    const data = await api({
      action: 'query', list: 'search', srsearch: `intitle:${term}`,
      srnamespace: '6', srlimit: '30',
    })
    const hits = (data.query?.search ?? [])
      .map((h) => h.title)
      .filter((t) => t.endsWith('.ogg'))
    console.log(`\nWiki files matching "${term}":`)
    for (const h of hits) console.log(`  ${h}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
