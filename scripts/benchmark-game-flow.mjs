#!/usr/bin/env node

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
const runs = Math.max(1, Number.parseInt(String(args.get('runs') ?? '3'), 10) || 3)
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright'
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE || undefined
const { chromium } = await import(playwrightModule)

const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
const average = values => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
const rounded = value => Number(value.toFixed(1))

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

async function waitForMode(page, mode) {
  await page.waitForFunction(expected => {
    const scene = window.__clashGame?.scene?.getScene?.('MainScene')
    const overlay = document.querySelector('.cloud-overlay')
    if (scene?.mode !== expected || overlay) return false
    return expected === 'HOME'
      ? Boolean(document.querySelector('.action-btn.raid'))
      : Boolean(document.querySelector('.action-btn.home'))
  }, mode, { timeout: 120_000, polling: 50 })
}

function apiPath(url) {
  try {
    const parsed = new URL(url)
    return parsed.pathname.replace(/^\/api/, '') + parsed.search
  } catch {
    return url
  }
}

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const pageErrors = []
page.on('pageerror', error => pageErrors.push(error.message))

try {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const gate = page.locator('.auth-gate-panel')
  await gate.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined)
  if (await gate.isVisible().catch(() => false)) {
    const suffix = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e5).toString(36)}`.slice(-10)
    await gate.locator('input[autocomplete="username"]').fill(`flow_${suffix}`.slice(0, 18))
    await gate.locator('input[type="password"]').fill('Benchmark!2026')
    await gate.getByRole('button', { name: 'CREATE ACCOUNT' }).click()
    await gate.waitFor({ state: 'detached', timeout: 60_000 })
  }
  await completeBanner(page)
  await waitForMode(page, 'HOME')

  const samples = []
  for (let run = 0; run < runs; run += 1) {
    const requests = []
    const started = new WeakMap()
    const onRequest = request => {
      if (!request.url().startsWith(`${baseUrl}/api/`)) return
      started.set(request, performance.now())
    }
    const onResponse = response => {
      const request = response.request()
      const began = started.get(request)
      if (began === undefined) return
      requests.push({
        method: request.method(),
        path: apiPath(request.url()),
        status: response.status(),
        elapsedMs: rounded(performance.now() - began)
      })
    }
    page.on('request', onRequest)
    page.on('response', onResponse)

    await page.locator('.action-btn.raid').click()
    const barbarian = page.locator('.faction-troop-card').filter({ hasText: 'Barbarian' }).first()
    await barbarian.waitFor({ state: 'visible', timeout: 30_000 })
    const attackStartedAt = performance.now()
    await barbarian.click()
    const findMatch = page.locator('.header-btn.find-match')
    await findMatch.waitFor({ state: 'visible', timeout: 10_000 })
    await findMatch.click()
    await waitForMode(page, 'ATTACK')
    const trainToAttackMs = performance.now() - attackStartedAt

    const attackRequests = requests.splice(0)
    const homeStartedAt = performance.now()
    await page.locator('.action-btn.home').click()
    await waitForMode(page, 'HOME')
    const returnHomeMs = performance.now() - homeStartedAt
    const homeRequests = requests.splice(0)

    page.off('request', onRequest)
    page.off('response', onResponse)
    samples.push({
      trainToAttackMs: rounded(trainToAttackMs),
      returnHomeMs: rounded(returnHomeMs),
      attackApiRequests: attackRequests.length,
      homeApiRequests: homeRequests.length,
      attackRequests,
      homeRequests
    })
  }

  const report = {
    label,
    baseUrl,
    runs,
    trainToAttackAverageMs: rounded(average(samples.map(sample => sample.trainToAttackMs))),
    returnHomeAverageMs: rounded(average(samples.map(sample => sample.returnHomeMs))),
    attackApiRequestAverage: rounded(average(samples.map(sample => sample.attackApiRequests))),
    homeApiRequestAverage: rounded(average(samples.map(sample => sample.homeApiRequests))),
    pageErrors,
    samples
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (pageErrors.length > 0) process.exitCode = 1
} finally {
  await context.close()
  await browser.close()
}
