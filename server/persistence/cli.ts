import path from 'node:path'
import { buildLegacyImportPlan, importLegacyPlan, verifyLegacyImport } from './legacy-import'
import { materializeLegacySnapshot } from './legacy-snapshot'
import { migrate } from './migrations'
import { postgresFromEnvironment } from './postgres/database'

function option(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
}

function requiredCutoff(): Date {
  const raw = option('cutoff')
  if (!raw) throw new Error('--cutoff=<ISO-8601 timestamp> is required for deterministic import')
  const cutoff = new Date(raw)
  if (!Number.isFinite(cutoff.getTime())) throw new Error(`Invalid cutoff timestamp: ${raw}`)
  return cutoff
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'materialize-legacy') {
    const output = option('output')
    if (!output) throw new Error('--output=<frozen snapshot directory> is required')
    const result = materializeLegacySnapshot({
      dataRoot: option('data') ?? path.resolve('server/data'),
      outputRoot: output,
      cutoffAt: requiredCutoff()
    })
    print({
      dataRoot: result.dataRoot,
      outputRoot: result.outputRoot,
      cutoffAt: result.manifest.cutoffAt,
      simulationVersion: result.manifest.simulationVersion,
      sourceSnapshotSha256: result.manifest.sourceSnapshotSha256,
      snapshotSha256: result.manifest.snapshotSha256,
      collections: result.manifest.collections,
      players: result.manifest.players,
      totals: result.manifest.totals
    })
    return
  }
  if (command === 'validate-legacy') {
    const plan = buildLegacyImportPlan(option('data') ?? path.resolve('server/data'), requiredCutoff())
    print({ dataRoot: plan.dataRoot, cutoffAt: plan.cutoffAt, counts: plan.counts, issues: plan.issues })
    if (plan.issues.some(issue => issue.severity === 'error')) process.exitCode = 1
    return
  }
  if (command !== 'migrate' && command !== 'import-legacy' && command !== 'verify-legacy') {
    throw new Error('Usage: persistence <materialize-legacy|migrate|validate-legacy|import-legacy|verify-legacy> [--data=...] [--output=...] [--cutoff=...]')
  }
  const database = postgresFromEnvironment()
  try {
    if (command === 'migrate') {
      await migrate(database)
      print({ migrated: true })
      return
    }
    const plan = buildLegacyImportPlan(option('data') ?? path.resolve('server/data'), requiredCutoff())
    if (command === 'import-legacy') {
      await migrate(database)
      const result = await importLegacyPlan(database, plan)
      const verification = await verifyLegacyImport(database, plan)
      print({ result, verification, warnings: plan.issues.filter(issue => issue.severity === 'warning') })
      if (!verification.ok) process.exitCode = 1
      return
    }
    const verification = await verifyLegacyImport(database, plan)
    print(verification)
    if (!verification.ok) process.exitCode = 1
  } finally {
    await database.close()
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
