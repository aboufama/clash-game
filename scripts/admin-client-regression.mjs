import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [portal, api] = await Promise.all([
  readFile(new URL('../src/admin/AdminPortal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/admin/api.ts', import.meta.url), 'utf8'),
])

const resourceAction = portal.slice(
  portal.indexOf("if (action === 'adjust_resources')"),
  portal.indexOf("} else if (action === 'set_trophies')"),
)
for (const resource of ['gold', 'ore', 'food']) {
  assert.match(resourceAction, new RegExp(`body\\.${resource} = Number\\(${resource}Delta\\)`),
    `The admin adjustment request must include the ${resource} control value`)
  assert.match(portal, new RegExp(`id="${resource}-delta"[\\s\\S]*?value=\\{${resource}Delta\\}[\\s\\S]*?set${resource[0].toUpperCase()}${resource.slice(1)}Delta`),
    `The ${resource} input must remain wired to its own controlled state`)
}
assert.match(api, /post\(path: string, body: JsonRecord\)[\s\S]*?body: JSON\.stringify\(body\)/,
  'AdminApi must serialize the complete resource action body')

const dataHook = portal.slice(
  portal.indexOf('function useAdminData('),
  portal.indexOf('function refreshAdminData('),
)
assert.match(dataHook, /result\.path === path[\s\S]*?result\.state\.kind === 'ready'[\s\S]*?result\.state\.kind === 'empty'/,
  'Same-endpoint revalidation must recognize a reusable authoritative snapshot')
assert.match(dataHook, /const refreshing = !isCurrent && canReuseSnapshot/,
  'The data hook must expose revalidation separately from initial loading')
assert.match(dataHook, /isCurrent \|\| canReuseSnapshot \? result\.state : \{ kind: 'loading' \}/,
  'A slow refresh must preserve the prior player detail instead of falling back to a summary row')
assert.match(portal, /refreshing \? <div role="status"[\s\S]*?Refreshing authoritative balances…/,
  'Player detail must disclose that its preserved balances are being refreshed')

const playerDetail = portal.slice(
  portal.indexOf('function PlayerDetail('),
  portal.indexOf('function PlayersView('),
)
assert.match(playerDetail, /onComplete=\{message => \{ setAction\(null\); setNotice\(message\); reload\(\); onChanged\(\) \}\}/,
  'A successful player action must revalidate both detail and directory state')

assert.match(portal, /type PlayerAction = [^\n]*'set_test_mode'/,
  'Test mode must remain an explicit audited player action')
assert.match(portal, /body\.override = testModeOverride === 'inherit' \? null : testModeOverride === 'enabled'/,
  'The player test-mode selector must preserve enabled, disabled, and inherited states')
assert.match(portal, /id="player-test-mode-override"[\s\S]*?Inherit realm setting[\s\S]*?Enabled for this player[\s\S]*?Disabled for this player/,
  'The player dialog must expose the complete tri-state policy')
assert.match(portal, /adminApi\.post\(`players\/\$\{encodeURIComponent\(playerId\)\}\/actions`, body\)/,
  'Player test-mode changes must use the authenticated player-action route')

assert.match(portal, /type OperationType = [^\n]*'set_test_mode'/,
  'Realm test mode must remain an explicit audited global operation')
assert.match(portal, /id="global-test-mode-enabled"/,
  'The realm test-mode switch must expose a stable accessible control id')
assert.match(portal, /operation === 'set_test_mode' \? \{ enabled \} : \{\}/,
  'The global operation must submit the selected enabled state')
assert.match(portal, /adminApi\.post\('operations', \{[\s\S]*?type: operation/,
  'Realm test-mode changes must use the authenticated operations route')
assert.match(portal, /data-testid="global-test-mode-card"/,
  'Live operations must display the authoritative realm test-mode state')
assert.match(portal, /function TestModePill\([\s\S]*?data-test-mode-effective[\s\S]*?data-test-mode-source/,
  'Player surfaces must distinguish effective test mode from its inheritance source')

console.log('admin client regression: resource, refresh, and test-mode wiring checks passed')
