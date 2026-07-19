import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'
import {
  advanceVillage,
  appearanceRevisionDelta,
  VILLAGE_SIMULATION_VERSION,
  type SimulatableVillage,
  type VillageAdvanceResult
} from '../domain/village/simulation'
import type { JsonObject, JsonValue } from './model'

/** Every directory-backed collection owned by the legacy JSON server. */
export const LEGACY_COLLECTIONS = [
  'players',
  'replays',
  'settlements',
  'bot-raids',
  'bot-villages',
  'notifications',
  'ledger',
  'world-state'
] as const

export type LegacyCollection = typeof LEGACY_COLLECTIONS[number]

export const LEGACY_CUTOVER_MANIFEST = 'cutover-manifest.json'
export const LEGACY_CUTOVER_FORMAT = 'clash-legacy-cutover-v1'

const MAX_BALANCE = 1_000_000_000

interface SnapshotFile {
  collection: LegacyCollection
  key: string
  relativePath: string
  raw: string
  value: JsonObject
  sha256: string
}

export interface LegacyCutoverTotals {
  gold: number
  ore: number
  food: number
  trophies: number
  population: number
}

export interface LegacyCutoverManifestFile {
  collection: LegacyCollection
  key: string
  sourceSha256: string
  outputSha256: string
}

export interface LegacyCutoverManifest {
  format: typeof LEGACY_CUTOVER_FORMAT
  cutoffAt: string
  cutoffEpochMs: number
  simulationVersion: number
  sourceSnapshotSha256: string
  snapshotSha256: string
  collections: Record<LegacyCollection, { records: number; sha256: string }>
  files: LegacyCutoverManifestFile[]
  players: {
    materialized: number
    appearanceRevisionsAdvanced: number
    completedUpgrades: number
    births: number
    departures: number
  }
  totals: {
    before: LegacyCutoverTotals
    after: LegacyCutoverTotals
    produced: { gold: number; ore: number; food: number }
    foodConsumed: number
  }
}

export interface MaterializeLegacySnapshotOptions {
  dataRoot: string
  outputRoot: string
  cutoffAt: Date
}

export interface MaterializeLegacySnapshotResult {
  dataRoot: string
  outputRoot: string
  manifest: LegacyCutoverManifest
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value: JsonValue | undefined, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function nonNegativeInteger(value: JsonValue | undefined, fallback = 0): number {
  return Math.max(0, Math.trunc(finiteNumber(value, fallback)))
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function aggregateChecksum(files: readonly { collection: string; key: string; sha256: string }[]): string {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.collection}\0${file.key}\0${file.sha256}\n`)
  return hash.digest('hex')
}

function syncDirectory(directory: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(directory, 'r')
    fsyncSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function writeDurably(filename: string, raw: string): void {
  let descriptor: number | null = null
  try {
    descriptor = openSync(filename, 'wx', 0o600)
    writeFileSync(descriptor, raw, 'utf8')
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function assertSeparateOutput(dataRoot: string, outputRoot: string): void {
  const relative = path.relative(dataRoot, outputRoot)
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('Frozen output must be outside the source data directory')
  }
}

/** Resolve symlink aliases even when the final output path does not exist yet. */
function canonicalFuturePath(target: string): string {
  const missing: string[] = []
  let existing = path.resolve(target)
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missing.unshift(path.basename(existing))
    existing = parent
  }
  return path.join(realpathSync(existing), ...missing)
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A live owner can mutate several records while they are being read. */
function assertNoLiveDataOwner(dataRoot: string): void {
  const lockPath = path.join(dataRoot, '.clash-server.lock')
  if (!existsSync(lockPath)) return
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown }
    const pid = Number(lock.pid)
    if (processIsAlive(pid)) {
      throw new Error(`Source data directory is owned by live server process ${pid}; stop legacy writes before cutover`)
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Source data directory has an unreadable server lock; refusing a potentially live snapshot')
    }
    throw error
  }
}

function scanSnapshot(dataRoot: string): SnapshotFile[] {
  if (!existsSync(dataRoot) || !statSync(dataRoot).isDirectory()) {
    throw new Error(`Legacy data directory does not exist: ${dataRoot}`)
  }

  const known = new Set<string>(LEGACY_COLLECTIONS)
  for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || known.has(entry.name)) continue
    const directory = path.join(dataRoot, entry.name)
    if (readdirSync(directory, { withFileTypes: true }).some(child => child.isFile() && child.name.endsWith('.json'))) {
      throw new Error(`Unknown legacy JSON collection ${entry.name}; refusing to omit it from the frozen snapshot`)
    }
  }

  const files: SnapshotFile[] = []
  for (const collection of LEGACY_COLLECTIONS) {
    const directory = path.join(dataRoot, collection)
    if (!existsSync(directory)) continue
    if (!statSync(directory).isDirectory()) throw new Error(`Legacy collection is not a directory: ${collection}`)
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => compareText(a.name, b.name))) {
      if (entry.name.endsWith('.tmp')) continue
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        if (entry.name.startsWith('.')) continue
        throw new Error(`Unsupported entry in legacy collection: ${collection}/${entry.name}`)
      }
      const key = entry.name.slice(0, -'.json'.length)
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(key)) throw new Error(`Unsafe legacy record key: ${collection}/${key}`)
      const relativePath = `${collection}/${entry.name}`
      const raw = readFileSync(path.join(dataRoot, relativePath), 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        throw new Error(`Invalid JSON in ${relativePath}: ${error instanceof Error ? error.message : 'parse failed'}`)
      }
      if (!isObject(parsed)) throw new Error(`Top-level JSON value must be an object: ${relativePath}`)
      files.push({ collection, key, relativePath, raw, value: parsed, sha256: sha256(raw) })
    }
  }
  return files.sort((a, b) => compareText(a.collection, b.collection) || compareText(a.key, b.key))
}

function liveAuthorityPhase(value: JsonObject): string {
  const authority = isObject(value.authority) ? value.authority : undefined
  return typeof authority?.phase === 'string' ? authority.phase.toUpperCase() : ''
}

function assertNoLiveAttacks(files: readonly SnapshotFile[]): void {
  const livePlayer = files.filter(file => file.collection === 'replays' && (
    file.value.status === 'live'
    || ['PREPARING', 'ENGAGED', 'ACTIVE', 'FINALIZING'].includes(liveAuthorityPhase(file.value))
  ))
  const liveBots = files.filter(file => file.collection === 'bot-raids'
    && (file.value.status === 'live' || file.value.status === 'settling'))
  if (livePlayer.length > 0 || liveBots.length > 0) {
    const records = [...livePlayer, ...liveBots].map(file => file.relativePath).join(', ')
    throw new Error(`Cutover requires every PvP and bot attack to be terminal; live records: ${records}`)
  }
}

function totalsOf(players: readonly JsonObject[]): LegacyCutoverTotals {
  return players.reduce<LegacyCutoverTotals>((totals, player) => ({
    gold: totals.gold + Math.max(0, finiteNumber(player.balance)),
    ore: totals.ore + nonNegativeInteger(player.ore),
    food: totals.food + nonNegativeInteger(player.food),
    trophies: totals.trophies + nonNegativeInteger(player.trophies),
    population: totals.population + nonNegativeInteger(isObject(player.population) ? player.population.count : undefined)
  }), { gold: 0, ore: 0, food: 0, trophies: 0, population: 0 })
}

interface MaterializedPlayer {
  raw: string
  value: JsonObject
  result: VillageAdvanceResult
  appearanceRevisionAdvanced: boolean
}

function materializePlayer(file: SnapshotFile, cutoff: number): MaterializedPlayer {
  const player = structuredClone(file.value)
  if (player.id !== file.key) throw new Error(`Player id must match record key: ${file.relativePath}`)
  if (!Array.isArray(player.buildings)) throw new Error(`Player buildings must be an array: ${file.relativePath}`)
  if (!Array.isArray(player.obstacles)) throw new Error(`Player obstacles must be an array: ${file.relativePath}`)
  if (!isObject(player.army)) throw new Error(`Player army must be an object: ${file.relativePath}`)
  for (const field of [
    'balance', 'ore', 'food', 'createdAt', 'lastSeen', 'lastAccrualAt', 'lastMutationAt', 'revision'
  ] as const) {
    if (typeof player[field] !== 'number' || !Number.isFinite(player[field])) {
      throw new Error(`Player ${field} must be finite: ${file.relativePath}`)
    }
  }
  if (finiteNumber(player.lastAccrualAt) > cutoff) {
    throw new Error(`Player simulation checkpoint is after the cutover: ${file.relativePath}`)
  }
  if (player.simulatedThrough !== undefined) {
    const simulatedThrough = finiteNumber(player.simulatedThrough, -1)
    if (simulatedThrough > cutoff) {
      throw new Error(`Player simulatedThrough is after the cutover: ${file.relativePath}`)
    }
    if (player.simulationVersion === VILLAGE_SIMULATION_VERSION
      && simulatedThrough !== finiteNumber(player.lastAccrualAt)) {
      throw new Error(`Player simulation checkpoints disagree: ${file.relativePath}`)
    }
  }
  if (finiteNumber(player.lastMutationAt) > cutoff) {
    throw new Error(`Player mutation checkpoint is after the cutover: ${file.relativePath}`)
  }
  if (finiteNumber(player.createdAt) > cutoff || finiteNumber(player.lastSeen) > cutoff) {
    throw new Error(`Player account activity is after the cutover: ${file.relativePath}`)
  }
  if (player.simulationVersion !== undefined
    && (typeof player.simulationVersion !== 'number' || !Number.isFinite(player.simulationVersion))) {
    throw new Error(`Player simulationVersion must be numeric: ${file.relativePath}`)
  }
  const sourceVersion = finiteNumber(player.simulationVersion, 1)
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > VILLAGE_SIMULATION_VERSION) {
    throw new Error(`Player uses unsupported simulation version ${sourceVersion}: ${file.relativePath}`)
  }
  if (sourceVersion === VILLAGE_SIMULATION_VERSION && player.simulatedThrough === undefined) {
    throw new Error(`Player simulation checkpoint is missing: ${file.relativePath}`)
  }

  for (const field of ['revision', 'layoutRevision', 'appearanceRevision'] as const) {
    if (player[field] === undefined) continue
    const revision = finiteNumber(player[field], -1)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new Error(`Player ${field} must be a non-negative safe integer: ${file.relativePath}`)
    }
  }
  const legacyRevision = nonNegativeInteger(player.revision)
  player.layoutRevision = nonNegativeInteger(player.layoutRevision, legacyRevision)
  const previousAppearanceRevision = nonNegativeInteger(player.appearanceRevision, legacyRevision)
  player.appearanceRevision = previousAppearanceRevision

  const result = advanceVillage(player as unknown as SimulatableVillage, cutoff, { maxBalance: MAX_BALANCE })
  if (result.nextEventAt === undefined) delete player.nextEventAt
  else player.nextEventAt = result.nextEventAt
  const revisionDelta = appearanceRevisionDelta(result)
  const appearanceRevisionAdvanced = revisionDelta > 0
  if (appearanceRevisionAdvanced) {
    if (previousAppearanceRevision > Number.MAX_SAFE_INTEGER - revisionDelta) {
      throw new Error(`Player appearanceRevision cannot advance safely: ${file.relativePath}`)
    }
    player.appearanceRevision = previousAppearanceRevision + revisionDelta
  }
  if (result.appearanceChanged) {
    const builtAt = (player.buildings as JsonValue[])
      .filter(isObject)
      .map(building => finiteNumber(building.builtAt))
    player.lastMutationAt = Math.max(finiteNumber(player.lastMutationAt), ...builtAt)
  }
  return { raw: JSON.stringify(player), value: player, result, appearanceRevisionAdvanced }
}

function collectionChecksums(files: readonly LegacyCutoverManifestFile[]): LegacyCutoverManifest['collections'] {
  return Object.fromEntries(LEGACY_COLLECTIONS.map(collection => {
    const records = files.filter(file => file.collection === collection)
    return [collection, {
      records: records.length,
      sha256: aggregateChecksum(records.map(record => ({ ...record, sha256: record.outputSha256 })))
    }]
  })) as LegacyCutoverManifest['collections']
}

function sameSourceSnapshot(before: readonly SnapshotFile[], after: readonly SnapshotFile[]): boolean {
  if (before.length !== after.length) return false
  return before.every((file, index) => {
    const current = after[index]
    return current?.relativePath === file.relativePath && current.sha256 === file.sha256
  })
}

/**
 * Publish an immutable cutover directory without ever writing into the source.
 * The directory rename is the only publication step; a failed run leaves no
 * partially visible output.
 */
export function materializeLegacySnapshot(options: MaterializeLegacySnapshotOptions): MaterializeLegacySnapshotResult {
  const dataRoot = realpathSync(path.resolve(options.dataRoot))
  const outputRoot = canonicalFuturePath(options.outputRoot)
  const cutoff = options.cutoffAt.getTime()
  if (!Number.isFinite(cutoff)) throw new Error('Cutover timestamp is invalid')
  assertSeparateOutput(dataRoot, outputRoot)
  assertNoLiveDataOwner(dataRoot)
  if (existsSync(outputRoot)) throw new Error(`Frozen output already exists: ${outputRoot}`)

  const sourceFiles = scanSnapshot(dataRoot)
  assertNoLiveAttacks(sourceFiles)

  const playerFiles = sourceFiles.filter(file => file.collection === 'players')
  const beforePlayers = playerFiles.map(file => file.value)
  const materialized = new Map<string, MaterializedPlayer>()
  for (const file of playerFiles) materialized.set(file.relativePath, materializePlayer(file, cutoff))
  const afterPlayers = playerFiles.map(file => materialized.get(file.relativePath)!.value)

  const manifestFiles: LegacyCutoverManifestFile[] = sourceFiles.map(file => ({
    collection: file.collection,
    key: file.key,
    sourceSha256: file.sha256,
    outputSha256: file.collection === 'players' ? sha256(materialized.get(file.relativePath)!.raw) : file.sha256
  }))
  const simulationResults = [...materialized.values()]
  const manifest: LegacyCutoverManifest = {
    format: LEGACY_CUTOVER_FORMAT,
    cutoffAt: new Date(cutoff).toISOString(),
    cutoffEpochMs: cutoff,
    simulationVersion: VILLAGE_SIMULATION_VERSION,
    sourceSnapshotSha256: aggregateChecksum(sourceFiles),
    snapshotSha256: aggregateChecksum(manifestFiles.map(file => ({ ...file, sha256: file.outputSha256 }))),
    collections: collectionChecksums(manifestFiles),
    files: manifestFiles,
    players: {
      materialized: materialized.size,
      appearanceRevisionsAdvanced: simulationResults.filter(item => item.appearanceRevisionAdvanced).length,
      completedUpgrades: simulationResults.reduce((sum, item) => sum + item.result.completedUpgradeIds.length, 0),
      births: simulationResults.reduce((sum, item) => sum + item.result.births, 0),
      departures: simulationResults.reduce((sum, item) => sum + item.result.departures, 0)
    },
    totals: {
      before: totalsOf(beforePlayers),
      after: totalsOf(afterPlayers),
      produced: simulationResults.reduce((totals, item) => ({
        gold: totals.gold + item.result.produced.gold,
        ore: totals.ore + item.result.produced.ore,
        food: totals.food + item.result.produced.food
      }), { gold: 0, ore: 0, food: 0 }),
      foodConsumed: simulationResults.reduce((sum, item) => sum + item.result.foodConsumed, 0)
    }
  }

  mkdirSync(path.dirname(outputRoot), { recursive: true })
  const stagingRoot = `${outputRoot}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  let stagingCreated = false
  try {
    mkdirSync(stagingRoot, { mode: 0o700 })
    stagingCreated = true
    for (const collection of LEGACY_COLLECTIONS) mkdirSync(path.join(stagingRoot, collection), { mode: 0o700 })
    for (const file of sourceFiles) {
      const outputRaw = file.collection === 'players' ? materialized.get(file.relativePath)!.raw : file.raw
      writeDurably(path.join(stagingRoot, file.relativePath), outputRaw)
    }
    for (const collection of LEGACY_COLLECTIONS) syncDirectory(path.join(stagingRoot, collection))
    writeDurably(path.join(stagingRoot, LEGACY_CUTOVER_MANIFEST), JSON.stringify(manifest, null, 2))
    syncDirectory(stagingRoot)

    assertNoLiveDataOwner(dataRoot)
    if (!sameSourceSnapshot(sourceFiles, scanSnapshot(dataRoot))) {
      throw new Error('Source data changed while materializing; no frozen snapshot was published')
    }
    if (existsSync(outputRoot)) throw new Error(`Frozen output appeared during materialization: ${outputRoot}`)
    renameSync(stagingRoot, outputRoot)
    syncDirectory(path.dirname(outputRoot))
  } catch (error) {
    if (stagingCreated) rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
  return { dataRoot, outputRoot, manifest }
}

function totalsEqual(left: LegacyCutoverTotals, right: LegacyCutoverTotals): boolean {
  return (['gold', 'ore', 'food', 'trophies', 'population'] as const)
    .every(field => Math.abs(left[field] - right[field]) <= (field === 'gold' ? 1e-9 : 0))
}

/** Verify the materializer's sealed output before constructing an import plan. */
export function verifyFrozenLegacySnapshot(dataRoot: string, cutoffAt: Date): string[] {
  const root = path.resolve(dataRoot)
  const manifestPath = path.join(root, LEGACY_CUTOVER_MANIFEST)
  if (!existsSync(manifestPath)) return [`Missing ${LEGACY_CUTOVER_MANIFEST}; run the materialization command before import`]
  let manifest: LegacyCutoverManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as LegacyCutoverManifest
  } catch (error) {
    return [`Invalid ${LEGACY_CUTOVER_MANIFEST}: ${error instanceof Error ? error.message : 'parse failed'}`]
  }
  const issues: string[] = []
  if (manifest.format !== LEGACY_CUTOVER_FORMAT) issues.push(`Unsupported cutover manifest format: ${String(manifest.format)}`)
  if (manifest.cutoffEpochMs !== cutoffAt.getTime() || manifest.cutoffAt !== cutoffAt.toISOString()) {
    issues.push('Cutover manifest timestamp does not match --cutoff')
  }
  if (manifest.simulationVersion !== VILLAGE_SIMULATION_VERSION) {
    issues.push(`Cutover manifest simulation version must be ${VILLAGE_SIMULATION_VERSION}`)
  }

  let files: SnapshotFile[]
  try {
    files = scanSnapshot(root)
    assertNoLiveAttacks(files)
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'Could not scan frozen snapshot')
    return issues
  }
  const actualFiles = files.map(file => ({ collection: file.collection, key: file.key, outputSha256: file.sha256 }))
  const expectedFiles = Array.isArray(manifest.files) ? manifest.files : []
  if (actualFiles.length !== expectedFiles.length) issues.push('Cutover manifest file count does not match the snapshot')
  for (let index = 0; index < Math.max(actualFiles.length, expectedFiles.length); index += 1) {
    const actual = actualFiles[index]
    const expected = expectedFiles[index]
    if (!actual || !expected || actual.collection !== expected.collection || actual.key !== expected.key
      || actual.outputSha256 !== expected.outputSha256) {
      issues.push(`Cutover manifest checksum mismatch at ${actual ? `${actual.collection}/${actual.key}` : `entry ${index}`}`)
    }
  }
  const actualSnapshotChecksum = aggregateChecksum(files)
  if (manifest.snapshotSha256 !== actualSnapshotChecksum) issues.push('Cutover snapshot aggregate checksum does not match')
  const sourceEntriesValid = expectedFiles.every(file => file
    && typeof file.collection === 'string'
    && typeof file.key === 'string'
    && typeof file.sourceSha256 === 'string')
  const manifestSourceFiles = sourceEntriesValid
    ? expectedFiles.map(file => ({ collection: file.collection, key: file.key, sha256: file.sourceSha256 }))
    : []
  if (!sourceEntriesValid || manifest.sourceSnapshotSha256 !== aggregateChecksum(manifestSourceFiles)) {
    issues.push('Cutover source aggregate checksum is internally inconsistent')
  }

  for (const collection of LEGACY_COLLECTIONS) {
    const records = files.filter(file => file.collection === collection)
    const expected = manifest.collections?.[collection]
    const digest = aggregateChecksum(records)
    if (!expected || expected.records !== records.length || expected.sha256 !== digest) {
      issues.push(`Cutover collection checksum does not match: ${collection}`)
    }
  }
  const players = files.filter(file => file.collection === 'players').map(file => file.value)
  for (const player of players) {
    if (player.lastAccrualAt !== cutoffAt.getTime() || player.simulatedThrough !== cutoffAt.getTime()) {
      issues.push(`Player ${String(player.id)} is not materialized through the exact cutoff`)
    }
    if (player.simulationVersion !== VILLAGE_SIMULATION_VERSION) {
      issues.push(`Player ${String(player.id)} has the wrong simulation version`)
    }
  }
  if (manifest.players?.materialized !== players.length) issues.push('Cutover manifest player count does not match')
  if (!manifest.totals?.after || !totalsEqual(manifest.totals.after, totalsOf(players))) {
    issues.push('Cutover manifest post-simulation totals do not match')
  }
  return issues
}
