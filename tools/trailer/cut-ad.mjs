// Cut the short Clash ISO brand ad from real captured gameplay. The required
// fixed-camera maxing clip remains a separate deliverable; this edit is free
// to use cinematic camera motion, world travel, night, typography and music.
//
//   FFMPEG=/path/to/ffmpeg node tools/trailer/cut-ad.mjs
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg'
const out = process.env.OUT ?? `${HERE}clash-iso-ad-1080.mp4`
const font = process.env.FONT
  ?? '/System/Library/Fonts/Supplemental/Arial Black.ttf'

const inputs = [
  `${HERE}clips/01-dawn-reveal.webm`,
  `${HERE}clips/village-maxing-fixed-1080.webm`,
  `${HERE}clips/03-wilds.webm`,
  `${HERE}clips/05-dusk-dragon.webm`,
  `${ROOT}public/assets/audio/music/adventure.ogg`,
  `${ROOT}public/assets/audio/music/construction_level_up.ogg`
]

for (const path of inputs) {
  if (!existsSync(path)) throw new Error(`Missing ad source: ${path}`)
}
if (!existsSync(font)) throw new Error(`Missing title font: ${font}`)

const title = (text, size, y, from, to) => [
  `drawtext=fontfile='${font}'`,
  `text='${text}'`,
  `fontsize=${size}`,
  'fontcolor=0xffe7a3',
  'borderw=5',
  'bordercolor=0x17130d@0.95',
  'shadowx=4',
  'shadowy=5',
  'shadowcolor=black@0.7',
  'x=(w-text_w)/2',
  `y=${y}`,
  `enable='between(t,${from},${to})'`
].join(':')

const smallTitle = text => title(text, 66, 76, 0.4, 3.3)
const filters = [
  `[0:v]trim=start=0:end=4,setpts=PTS-STARTPTS,fps=60,scale=1920:1080:flags=neighbor,format=yuv420p,${smallTitle('START WITH A SPARK')}[v0]`,
  `[1:v]trim=start=5:end=13,setpts=PTS-STARTPTS,fps=60,scale=1920:1080:flags=neighbor,format=yuv420p,${title('RAISE A KINGDOM', 72, 76, 0.4, 3.8)}[v1]`,
  `[2:v]trim=start=0.7:end=5.2,setpts=PTS-STARTPTS,fps=60,scale=1920:1080:flags=neighbor,format=yuv420p,${title('DISCOVER A LIVING WORLD', 62, 76, 0.4, 3.8)}[v2]`,
  `[3:v]trim=start=0:end=3.5,setpts=PTS-STARTPTS,fps=60,scale=1920:1080:flags=neighbor,format=yuv420p,${title('RULE THROUGH THE NIGHT', 64, 76, 0.35, 2.85)}[v3]`,
  `[1:v]trim=start=20.4:end=25.4,setpts=PTS-STARTPTS,fps=60,scale=1920:1080:flags=neighbor,format=yuv420p,drawbox=x=0:y=342:w=iw:h=344:color=0x101923@0.50:t=fill:enable='between(t,0.75,5)',${title('CLASH ISO', 138, 405, 0.8, 5)},${title('BUILD  •  FORTIFY  •  RULE', 42, 590, 1.45, 5)}[v4]`,
  '[v0][v1]xfade=transition=fade:duration=0.35:offset=3.65[x1]',
  '[x1][v2]xfade=transition=fade:duration=0.35:offset=11.30[x2]',
  '[x2][v3]xfade=transition=fade:duration=0.35:offset=15.45[x3]',
  '[x3][v4]xfade=transition=fadeblack:duration=0.35:offset=18.60[vout]',
  '[4:a]atrim=start=0:end=23.60,asetpts=PTS-STARTPTS,volume=0.66,afade=t=in:st=0:d=0.45,afade=t=out:st=22.15:d=1.45[bed]',
  '[5:a]atrim=start=0:end=5.0,asetpts=PTS-STARTPTS,volume=0.34,afade=t=out:st=3.8:d=1.2,adelay=18600|18600[sting]',
  '[bed][sting]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]'
].join(';')

const result = spawnSync(ffmpeg, [
  '-y', '-hide_banner',
  '-i', inputs[0], '-i', inputs[1], '-i', inputs[2], '-i', inputs[3],
  '-i', inputs[4], '-i', inputs[5],
  '-filter_complex', filters,
  '-map', '[vout]', '-map', '[aout]',
  '-t', '23.60',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '14',
  '-pix_fmt', 'yuv420p', '-r', '60', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '256k', '-ar', '48000',
  out
], { stdio: 'inherit' })

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`wrote ${out}`)
