/**
 * One-off shared-world cleanup. Keeps exactly one player village intact,
 * removes abandoned/test villages, and clears multiplayer records that point
 * at the deleted accounts. The server must be stopped so its in-memory store
 * cannot write the removed records back afterward.
 *
 * Usage:
 *   node scripts/repopulate-world.mjs --data-dir server/data --keep-player p_...
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import path from 'node:path'

const valueAfter = flag => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? process.argv[at + 1] : undefined
}

const dataDir = path.resolve(valueAfter('--data-dir') ?? 'server/data')
const keepPlayer = valueAfter('--keep-player')
if (!keepPlayer || !/^p_[a-z0-9]+$/i.test(keepPlayer)) {
  throw new Error('A safe --keep-player p_... id is required')
}

const playerDir = path.join(dataDir, 'players')
const keepPath = path.join(playerDir, `${keepPlayer}.json`)
if (!existsSync(keepPath)) throw new Error(`Kept player does not exist: ${keepPath}`)
const kept = JSON.parse(readFileSync(keepPath, 'utf8'))
if (kept.id !== keepPlayer || !Array.isArray(kept.buildings) || kept.buildings.length === 0) {
  throw new Error('Kept player record failed integrity checks')
}

const lockPath = path.join(dataDir, '.clash-server.lock')
if (existsSync(lockPath)) {
  let lock
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    // Malformed/dead legacy locks do not own the directory.
  }

  if (Number.isInteger(lock?.pid)) {
    try {
      process.kill(lock.pid, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') lock = undefined
      else throw error
    }
    if (lock) throw new Error(`Refusing to repopulate while server process ${lock.pid} is live`)
  }
}

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const backupRoot = path.resolve(path.dirname(dataDir), 'data-backups')
const backupDir = path.join(backupRoot, `before-repopulate-${stamp}`)
mkdirSync(backupRoot, { recursive: true })
cpSync(dataDir, backupDir, { recursive: true })

let removedPlayers = 0
for (const file of readdirSync(playerDir)) {
  if (!file.endsWith('.json') || file === `${keepPlayer}.json`) continue
  rmSync(path.join(playerDir, file), { force: true })
  removedPlayers++
}

const clearedCollections = ['replays', 'notifications', 'settlements', 'bot-raids']
let removedRelatedRecords = 0
for (const collection of clearedCollections) {
  const dir = path.join(dataDir, collection)
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') && !file.endsWith('.tmp')) continue
    rmSync(path.join(dir, file), { force: true })
    removedRelatedRecords++
  }
}

console.log(JSON.stringify({
  kept: { id: kept.id, username: kept.username, plotX: kept.plotX, plotY: kept.plotY, buildings: kept.buildings.length },
  removedPlayers,
  removedRelatedRecords,
  backupDir
}, null, 2))
