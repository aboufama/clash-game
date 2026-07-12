import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const output = join(tmpdir(), `clash-world-postcard-residency-${process.pid}.mjs`)

try {
  await build({
    entryPoints: [new URL('./world-postcard-residency-regression.ts', import.meta.url).pathname],
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    logLevel: 'warning'
  })
  await import(`${pathToFileURL(output).href}?t=${Date.now()}`)
} finally {
  await rm(output, { force: true })
}
