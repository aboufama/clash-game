import { performance } from 'node:perf_hooks'
import { createPersistenceAttackService } from '../server/runtime/attack-service'
import { PersistenceGameService } from '../server/runtime/service'
import { MemoryPersistence } from '../server/persistence/memory'
import type { SessionResponse } from '../server/protocol'

const ITERATIONS = 25
const FIXED_NOW = new Date('2026-07-19T20:00:00.000Z')

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

async function main(): Promise<void> {
  const persistence = new MemoryPersistence()
  const attacks = createPersistenceAttackService(persistence, {
    now: () => FIXED_NOW,
    createId: prefix => `${prefix}_benchmark`
  })
  const service = new PersistenceGameService(persistence, {
    attacks,
    now: () => FIXED_NOW,
    allowGuestSessions: true
  })
  const session = await service.ensureSession(undefined, 'benchmark') as SessionResponse
  const principal = { playerId: session.player.id }
  await persistence.transaction(async tx => {
    const village = await tx.villages.get(principal.playerId)
    if (!village) throw new Error('Benchmark village was not created')
    village.buildings.push({
      id: 'benchmark-watchtower',
      type: 'watchtower',
      gridX: 30,
      gridY: 30,
      level: 2,
      builtAt: FIXED_NOW.getTime()
    })
    village.army = { warrior: 1 }
    const expected = village.economyRevision
    village.economyRevision += 1
    village.layoutRevision += 1
    village.appearanceRevision += 1
    village.lastMutationAt = FIXED_NOW
    if (!await tx.villages.update(village, expected)) throw new Error('Benchmark watchtower update lost')
  })

  const coldStartedAt = performance.now()
  const cold = await service.map(principal, undefined, undefined, 2)
  const coldMs = performance.now() - coldStartedAt
  const samples: number[] = []
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const startedAt = performance.now()
    await service.map(principal, undefined, undefined, 2)
    samples.push(performance.now() - startedAt)
  }
  const authBurstSamples: number[] = []
  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const startedAt = performance.now()
    await Promise.all(Array.from({ length: 5 }, () => service.authenticate(session.token)))
    authBurstSamples.push(performance.now() - startedAt)
  }
  const botStartStartedAt = performance.now()
  await attacks.botStart(principal, { requestId: 'benchmark-bot-start' }, session.token)
  const botStartMs = performance.now() - botStartStartedAt
  const plotRows = (cold as { plots?: Array<{ kind?: unknown }> }).plots ?? []
  const plots = plotRows.length
  const botPlots = plotRows.filter(plot => plot.kind === 'bot').length
  process.stdout.write(`${JSON.stringify({
    iterations: ITERATIONS,
    plots,
    botPlots,
    coldMs: Number(coldMs.toFixed(3)),
    warmAverageMs: Number(average(samples).toFixed(3)),
    warmMinMs: Number(Math.min(...samples).toFixed(3)),
    warmMaxMs: Number(Math.max(...samples).toFixed(3)),
    fiveRequestAuthBurstAverageMs: Number(average(authBurstSamples).toFixed(3)),
    persistedPoolBotStartMs: Number(botStartMs.toFixed(3)),
    postgresBotQueryModel: {
      baselineCold: botPlots * 4,
      optimizedCold: botPlots > 0 ? 3 : 1,
      baselineWarm: botPlots,
      optimizedWarm: 1
    }
  }, null, 2)}\n`)
  await service.close()
}

await main()
