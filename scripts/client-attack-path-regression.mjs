import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [app, notifications, backend, scene, worldMap] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/NotificationsPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/backend/GameBackend.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/scenes/MainScene.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/game/systems/WorldMapSystem.ts', import.meta.url), 'utf8')
])

assert.doesNotMatch(app, /Backend\.endAttack\(/,
  'App must consume MainScene settlement results instead of settling PvP twice')
assert.match(app, /onRevenge=\{handleDirectUserAttack\}/,
  'Revenge must route through the shared direct-user army gate')
assert.doesNotMatch(notifications, /gameManager\.startAttackOnUser/,
  'Notification UI must not bypass App attack gating')

for (const field of ['x', 'y', 'seed']) {
  assert.match(backend, new RegExp(`Number\\.isInteger\\(result\\.${field}\\)`),
    `Bot start must validate integer ${field}`)
}
assert.ok((backend.match(/Backend\.validStartedBotRaid\(result\)/g) ?? []).length >= 2,
  'Normal and recovered bot starts must share runtime validation')

assert.ok((scene.match(/arriveAndFightSafely\(/g) ?? []).length >= 3,
  'Both road attack callbacks must use the contained arrival handoff')
assert.match(scene, /recoverIssuedAttackFailure[\s\S]*?finally\s*\{[\s\S]*?finishExclusiveTransition\(epoch\)/,
  'Issued road-attack recovery must always release the transition lock')
assert.match(scene, /recoverIssuedAttackFailure[\s\S]*?abortBotSession\(meta\)[\s\S]*?Backend\.endAttack\(meta\.attackId, 'aborted'/,
  'Issued road-attack recovery must close both bot and player sessions')
assert.match(worldMap, /prepareFocus[\s\S]*?const focusRadius = 1;/,
  'Battle focus must remain one local 3x3 ring regardless of exploration sight')

console.log('client attack path regression: 11 checks passed')
