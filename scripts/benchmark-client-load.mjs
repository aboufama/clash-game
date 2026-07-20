#!/usr/bin/env node

import { writeFile } from 'node:fs/promises'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index]
  if (!token.startsWith('--')) continue
  const [key, inline] = token.slice(2).split('=', 2)
  const value = inline ?? process.argv[index + 1]
  args.set(key, value)
  if (inline === undefined) index += 1
}

const baseUrl = String(args.get('url') ?? 'http://127.0.0.1:8788').replace(/\/$/, '')
const label = String(args.get('label') ?? 'candidate')
const runs = Math.max(1, Number.parseInt(String(args.get('runs') ?? '5'), 10) || 5)
const outputPath = args.get('out') ? String(args.get('out')) : null
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright'
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE || undefined
const { chromium } = await import(playwrightModule)

const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {})
})

const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b)
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ?? 0
}
const rounded = value => Number(value.toFixed(1))

async function waitForVillage(page) {
  await page.waitForFunction(() => {
    const scene = window.__clashGame?.scene?.getScene?.('MainScene')
    const playable = Number(scene?.getHomePlayableBuildingCount?.() ?? 0)
    return playable > 0
      && !document.querySelector('.cloud-overlay')
      && Boolean(document.querySelector('.action-btn.raid'))
  }, undefined, { timeout: 120_000, polling: 50 })
}

async function completeBanner(page) {
  const modal = page.locator('.banner-modal')
  try {
    await modal.waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    return
  }
  const grids = modal.locator('.banner-grid')
  await grids.nth(0).locator('button').first().click()
  await grids.nth(1).locator('button').first().click()
  await grids.nth(2).locator('button').first().click()
  await modal.locator('.banner-save-btn').click()
  await modal.waitFor({ state: 'detached', timeout: 30_000 })
}

async function seedAuthenticatedState() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const gate = page.locator('.auth-gate-panel')
  await gate.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined)
  if (await gate.isVisible().catch(() => false)) {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`.slice(-10)
    await gate.locator('input[autocomplete="username"]').fill(`bench_${suffix}`.slice(0, 18))
    await gate.locator('input[type="password"]').fill('Benchmark!2026')
    await gate.getByRole('button', { name: 'CREATE ACCOUNT' }).click()
    await gate.waitFor({ state: 'detached', timeout: 60_000 })
  }
  await completeBanner(page)
  await waitForVillage(page)
  const storageState = await context.storageState()
  await context.close()
  return storageState
}

async function measureNavigation(storageState, warmPage = null) {
  const context = warmPage ? null : await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState
  })
  const page = warmPage ?? await context.newPage()
  const seen = []
  const onResponse = response => {
    const url = response.url()
    if (!url.startsWith(baseUrl)) return
    seen.push({ url, status: response.status(), fromServiceWorker: response.fromServiceWorker() })
  }
  page.on('response', onResponse)
  const startedAt = Date.now()
  await page.goto(`${baseUrl}/?bench=${startedAt}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitForVillage(page)
  const revealMs = Date.now() - startedAt
  const resource = await page.evaluate(() => {
    const entries = performance.getEntriesByType('resource')
    const summarize = list => ({
      count: list.length,
      transferBytes: list.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      encodedBytes: list.reduce((sum, entry) => sum + (entry.encodedBodySize || 0), 0),
      decodedBytes: list.reduce((sum, entry) => sum + (entry.decodedBodySize || 0), 0),
      lastResponseEndMs: list.reduce((latest, entry) => Math.max(latest, entry.responseEnd || 0), 0)
    })
    return {
      all: summarize(entries),
      sprites: summarize(entries.filter(entry => entry.name.includes('/assets/sprites/'))),
      api: summarize(entries.filter(entry => entry.name.includes('/api/'))),
      scripts: summarize(entries.filter(entry => /\.js(?:\?|$)/.test(entry.name)))
    }
  })
  page.off('response', onResponse)
  const result = {
    revealMs,
    responseCount: seen.length,
    spriteResponses: seen.filter(item => item.url.includes('/assets/sprites/')).length,
    apiResponses: seen.filter(item => item.url.includes('/api/')).length,
    resource
  }
  if (context) await context.close()
  return result
}

try {
  const storageState = await seedAuthenticatedState()
  const cold = []
  for (let run = 0; run < runs; run += 1) cold.push(await measureNavigation(storageState))

  const warmContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    storageState
  })
  const warmPage = await warmContext.newPage()
  await measureNavigation(storageState, warmPage) // populate this context's HTTP cache
  const warm = []
  for (let run = 0; run < runs; run += 1) warm.push(await measureNavigation(storageState, warmPage))
  await warmContext.close()

  const summarizeRuns = samples => ({
    runs: samples.length,
    revealAverageMs: rounded(average(samples.map(sample => sample.revealMs))),
    revealP50Ms: rounded(percentile(samples.map(sample => sample.revealMs), 0.5)),
    revealP95Ms: rounded(percentile(samples.map(sample => sample.revealMs), 0.95)),
    responseAverage: rounded(average(samples.map(sample => sample.responseCount))),
    spriteResponseAverage: rounded(average(samples.map(sample => sample.spriteResponses))),
    apiResponseAverage: rounded(average(samples.map(sample => sample.apiResponses))),
    spriteTransferAverageMiB: rounded(average(samples.map(sample => sample.resource.sprites.transferBytes)) / 1_048_576),
    spriteDecodedAverageMiB: rounded(average(samples.map(sample => sample.resource.sprites.decodedBytes)) / 1_048_576)
  })
  const report = {
    label,
    baseUrl,
    measuredAt: new Date().toISOString(),
    cold: summarizeRuns(cold),
    warm: summarizeRuns(warm),
    samples: { cold, warm }
  }
  const json = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(json)
  if (outputPath) await writeFile(outputPath, json, 'utf8')
} finally {
  await browser.close()
}
