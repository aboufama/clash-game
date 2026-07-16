import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rm } from 'node:fs/promises'

const output = join(tmpdir(), `clash-pathing-regression-${process.pid}.mjs`)

try {
  await build({
    entryPoints: [new URL('./pathing-regression.ts', import.meta.url).pathname],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    alias: {
      phaser: new URL('./phaser-math-stub.ts', import.meta.url).pathname
    },
    logLevel: 'warning'
  })
  await import(`${pathToFileURL(output).href}?t=${Date.now()}`)
} finally {
  await rm(output, { force: true })
}
