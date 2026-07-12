import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(path.join(tmpdir(), 'clash-attack-domain-'))
const outfile = path.join(dir, 'regression.mjs')

try {
  await build({
    entryPoints: [path.resolve('scripts/attack-domain-regression.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent'
  })
  await import(`${pathToFileURL(outfile).href}?run=${Date.now()}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
