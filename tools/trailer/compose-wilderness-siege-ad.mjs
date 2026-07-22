// Join the exact-frame wilderness flyover to the live fortress finale with
// one gentle dissolve and a continuous music bed. No titles, logos, HUD, or
// other text are added.
//
//   FFMPEG=/path/to/ffmpeg node tools/trailer/compose-wilderness-siege-ad.mjs
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const HERE = new URL('./', import.meta.url).pathname
const ROOT = new URL('../../', import.meta.url).pathname
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg'
const FLYOVER = process.env.FLYOVER
  ?? `${HERE}clips/wilderness-village-variety-cloud-night-flyover-1080.mp4`
const FINALE = process.env.FINALE
  ?? `${HERE}clips/fortress-merchant-max-practice-1080.mp4`
const MUSIC = process.env.MUSIC
  ?? `${ROOT}public/assets/audio/music/adventure.ogg`
const OUT = (process.env.OUT ?? `${HERE}clips/`).replace(/\/$/, '')
const NAME = process.env.NAME ?? 'wilderness-to-fortress-siege-ad-1080'
const TRANSITION_SECONDS = Number(process.env.TRANSITION_SECONDS ?? 0.85)
const FPS = Number(process.env.FPS ?? 60)
const PRESET = process.env.PRESET ?? 'slow'

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

assert(Number.isInteger(FPS) && FPS === 60,
  `the commercial master must be 60 fps (received ${FPS})`)
assert(Number.isFinite(TRANSITION_SECONDS)
  && TRANSITION_SECONDS >= 0.25 && TRANSITION_SECONDS <= 1.5,
`TRANSITION_SECONDS must be 0.25-1.5 (received ${TRANSITION_SECONDS})`)
for (const path of [FLYOVER, FINALE, MUSIC]) {
  assert(existsSync(path), `missing commercial source: ${path}`)
}
mkdirSync(OUT, { recursive: true })

function durationOf(path) {
  // ffmpeg reports stream metadata before it rejects the intentionally
  // omitted output. This avoids requiring a separate ffprobe binary.
  const probe = spawnSync(FFMPEG, ['-hide_banner', '-i', path], { encoding: 'utf8' })
  if (probe.error) throw probe.error
  const match = probe.stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  assert(match, `ffmpeg could not read duration for ${path}:\n${probe.stderr}`)
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3])
}

const flyoverSeconds = durationOf(FLYOVER)
const finaleSeconds = durationOf(FINALE)
assert(flyoverSeconds > TRANSITION_SECONDS && finaleSeconds > TRANSITION_SECONDS,
  'a source is shorter than the requested dissolve')
const transitionAt = flyoverSeconds - TRANSITION_SECONDS
const totalSeconds = flyoverSeconds + finaleSeconds - TRANSITION_SECONDS
const fadeOutAt = Math.max(0, totalSeconds - 2)
const outputPath = `${OUT}/${NAME}.mp4`

const filter = [
  // Both verified masters are already 1920x1080 CFR 60. ffmpeg 7 marks the
  // output rate unknown when fps/setpts is inserted before xfade, so preserve
  // their native clock and let xfade consume the two matching streams.
  `[0:v][1:v]xfade=transition=fade:duration=${TRANSITION_SECONDS}:offset=${transitionAt},format=yuv420p[vout]`,
  `[2:a]atrim=0:${totalSeconds},asetpts=N/SR/TB,volume=0.72,afade=t=in:st=0:d=1.2,afade=t=out:st=${fadeOutAt}:d=2,loudnorm=I=-20:LRA=7:TP=-1.5[aout]`
].join(';')

const render = spawnSync(FFMPEG, [
  '-hide_banner', '-loglevel', 'warning', '-y',
  '-i', FLYOVER,
  '-i', FINALE,
  '-stream_loop', '-1', '-i', MUSIC,
  '-filter_complex', filter,
  '-map', '[vout]', '-map', '[aout]',
  '-t', String(totalSeconds),
  '-c:v', 'libx264', '-preset', PRESET, '-crf', '14',
  '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart',
  '-c:a', 'aac', '-ar', '48000', '-b:a', '256k',
  outputPath
], { encoding: 'utf8' })
if (render.error) throw render.error
assert(render.status === 0,
  `commercial render failed (code=${render.status}, signal=${render.signal}):\n${render.stderr}`)

const encodedSeconds = durationOf(outputPath)
assert(Math.abs(encodedSeconds - totalSeconds) <= 0.1,
  `commercial duration drifted (${encodedSeconds.toFixed(3)} vs ${totalSeconds.toFixed(3)} seconds)`)

const report = {
  output: outputPath,
  bytes: statSync(outputPath).size,
  width: 1920,
  height: 1080,
  fps: FPS,
  noTextOrOverlaysAdded: true,
  sources: {
    flyover: { path: FLYOVER, durationSeconds: flyoverSeconds },
    finale: { path: FINALE, durationSeconds: finaleSeconds },
    music: MUSIC
  },
  dissolve: {
    durationSeconds: TRANSITION_SECONDS,
    startsAtSeconds: transitionAt
  },
  durationSeconds: encodedSeconds
}
writeFileSync(`${OUT}/${NAME}-report.json`, JSON.stringify(report, null, 2))
console.log(`wrote ${outputPath} (${encodedSeconds.toFixed(2)}s, ${(report.bytes / 1e6).toFixed(1)} MB)`)
