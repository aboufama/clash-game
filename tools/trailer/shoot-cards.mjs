import puppeteer from 'puppeteer-core'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const input = resolve(process.argv[2] ?? process.env.CARDS_HTML ?? 'cards.html')
const output = resolve(process.argv[3] ?? process.env.OUT ?? dirname(input))
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ids = (process.env.CARD_IDS ?? 'c1,c2,c3,c4').split(',').map(id => id.trim()).filter(Boolean)

mkdirSync(output, { recursive: true })
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox']
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 720 })
  await page.goto(pathToFileURL(input).href, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await new Promise(resolve => setTimeout(resolve, 400))

  for (const id of ids) {
    const element = await page.$(`#${id}`)
    if (!element) throw new Error(`card element #${id} was not found in ${input}`)
    await element.screenshot({ path: resolve(output, `card-${id}.png`) })
  }
} finally {
  await browser.close()
}

console.log(`rendered ${ids.length} cards to ${output}`)
