/**
 * End-to-end test of the game server over real HTTP.
 * Usage: npm run build:server && node scripts/integration-test.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PORT = 8791
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'clash-test-'))

let server = null
let failures = 0
let checks = 0

function ok(condition, label) {
  checks += 1
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.error(`  ✗ ${label}`)
  }
}

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: String(PORT),
      CLASH_DATA_DIR: dataDir,
      CLASH_STARTER_SHIELD_MS: '0',
      CLASH_ALLOW_DEBUG_GRANTS: '1',
      CLASH_INFINITE_RESOURCES: '0',
      CLASH_ALLOW_WORLD_RESEED: '0',
      CLASH_TRUST_PROXY: '1',
      CLASH_AUTH_MUTATIONS_PER_10S: '10000',
      CLASH_AUTH_FRAME_PUSHES_PER_10S: '10000',
      CLASH_GUEST_LIMIT_PER_HOUR: '10000',
      // The historical HTTP suite still expresses deployments inside replay
      // frames. Production leaves this off; command-domain regressions and
      // the browser client exercise /attacks/commands directly.
      CLASH_ALLOW_LEGACY_FRAME_COMMANDS: '1',
      // Exercise the fixed-duration seam used by local development. The
      // package dev scripts set 1000ms; this suite uses 300ms to stay quick.
      CLASH_UPGRADE_TIME_SCALE: '0.001',
      CLASH_UPGRADE_DURATION_MS: '300',
      ...extraEnv,
      // This suite edits its temporary JSON records directly. Never let an
      // inherited production DATABASE_URL select the PostgreSQL authority.
      CLASH_STORAGE_MODE: 'legacy-json'
    }
    delete env.DATABASE_URL
    server = spawn('node', ['dist-server/index.mjs'], {
      env,
      stdio: ['ignore', 'pipe', 'inherit']
    })
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('running')) resolve()
    })
    server.on('exit', code => reject(new Error(`server exited early (${code})`)))
    setTimeout(() => reject(new Error('server start timeout')), 5000)
  })
}

function stopServer() {
  return new Promise(resolve => {
    if (!server) return resolve()
    server.removeAllListeners('exit')
    server.on('exit', resolve)
    server.kill('SIGTERM')
    setTimeout(resolve, 2000)
  })
}

async function api(method, pathName, { token, body, headers } = {}) {
  const response = await fetch(`${BASE}/api${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {})
    },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined
  })
  const json = await response.json().catch(() => null)
  return { status: response.status, json }
}

async function armWarriors(token, count, requestId) {
  const world = (await api('GET', '/world', { token })).json.world
  const have = world.army?.warrior ?? 0
  if (have >= count) return
  const missing = count - have
  if (world.resources.gold < missing * 25) {
    await api('POST', '/resources/apply', { token, body: { delta: missing * 25, reason: 'debug_grant', requestId: `${requestId}-gold` } })
  }
  if (world.resources.food < missing * 2) {
    await api('POST', '/resources/apply', { token, body: { delta: 200, resource: 'food', reason: 'debug_grant', requestId: `${requestId}-food` } })
  }
  const response = await api('POST', '/army/train', {
    token,
    body: { type: 'warrior', count: missing, requestId }
  })
  if (response.status !== 200) throw new Error(`could not arm test account: ${JSON.stringify(response.json)}`)
}

function validBattleFrames(attack, troopCount = 6, frameCount = 3, destroyedPercent = 100) {
  const targets = attack.world.buildings.filter(building => building.type !== 'wall')
  const destroyedCount = Math.ceil(targets.length * destroyedPercent / 100)
  const troops = Array.from({ length: troopCount }, (_, i) => ({
    id: `${attack.attackId}_w${i}`,
    type: 'warrior',
    level: 1,
    owner: 'PLAYER',
    gridX: 3 + i * 0.1,
    gridY: 3,
    health: 100,
    maxHealth: 100
  }))
  return Array.from({ length: frameCount }, (_, i) => {
    const final = i === frameCount - 1
    return {
      t: (i + 1) * 10,
      destruction: 100,
      goldLooted: 999999999,
      buildings: targets.map((building, index) => ({
        id: building.id,
        health: final && index < destroyedCount ? 0 : 1,
        isDestroyed: final && index < destroyedCount
      })),
      troops
    }
  })
}

async function matchmakeUntil(token, targetId, requestPrefix, maxAttempts = 250) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const requestId = `${requestPrefix}-${attempt}`
    const response = await api('POST', '/attacks/matchmake', { token, body: { requestId } })
    if (response.status !== 200) throw new Error(`matchmake failed: ${JSON.stringify(response.json)}`)
    if (response.json.world?.ownerId === targetId) return { ...response.json, requestId }
    await api('POST', '/attacks/end', { token, body: { attackId: response.json.attackId, status: 'aborted' } })
  }
  throw new Error(`could not match target ${targetId}`)
}

async function main() {
  await startServer()
  console.log('server up, data dir:', dataDir)

  // --- Liveness probe (used by uptime monitors / load balancers) ---
  const health = await api('GET', '/health', {})
  ok(health.status === 200, 'GET /api/health answers 200')

  // --- Auto account creation (no username/password/code) ---
  console.log('\nAuth:')
  const a = (await api('POST', '/auth/session')).json
  ok(a.created === true && a.token && a.player?.id, 'first visit auto-creates an account')
  ok(Array.isArray(a.world?.buildings) && a.world.buildings.length >= 4, 'new account gets a starter base')

  const again = (await api('POST', '/auth/session', { body: { token: a.token } })).json
  ok(again.created === false && again.player.id === a.player.id, 'same token resumes the same account')

  const bad = await api('GET', '/world', { token: 'tok_bogus' })
  ok(bad.status === 401, 'bogus token is rejected (401)')

  const b = (await api('POST', '/auth/session')).json
  ok(b.player.id !== a.player.id, 'second device gets its own account')

  // --- Base persistence ---
  console.log('\nPersistence:')
  const aWorld = a.world
  aWorld.buildings.push({ id: 'test_cannon_1', type: 'cannon', gridX: 2, gridY: 2, level: 1 })
  const saved = (await api('POST', '/world/save', { token: a.token, body: { world: aWorld, requestId: 'save-1' } })).json
  ok(saved.world.buildings.some(bl => bl.id === 'test_cannon_1'), 'save persists a new building')
  const savedRevision = saved.world.revision

  const replayedSave = (await api('POST', '/world/save', { token: a.token, body: { world: aWorld, requestId: 'save-1' } })).json
  ok(replayedSave.world.revision === savedRevision, 'duplicate requestId does not double-apply a save')
  const freshKeyNoop = (await api('POST', '/world/save', { token: a.token, body: { world: saved.world, requestId: 'save-noop-fresh-key' } })).json
  ok(freshKeyNoop.world.revision === savedRevision, 'an unchanged layout with a fresh key is a semantic no-op')

  const noTownHall = await api('POST', '/world/save', {
    token: a.token,
    body: { world: { ...saved.world, buildings: saved.world.buildings.filter(bl => bl.type !== 'town_hall') } }
  })
  ok(noTownHall.status === 400, 'saving a base without a town hall is rejected')

  const overlap = await api('POST', '/world/save', {
    token: a.token,
    body: { world: { ...saved.world, buildings: [...saved.world.buildings, { id: 'overlap', type: 'cannon', gridX: 11, gridY: 11, level: 1 }] } }
  })
  ok(overlap.status === 400, 'overlapping building footprints are rejected')

  // Seed a pre-footprint-change base directly on disk. Current saves must be
  // able to preserve/reduce its exact historical overlaps without opening a
  // path to create new collisions.
  const legacyLayoutOwner = (await api('POST', '/auth/session', { body: {} })).json
  const legacyEdgeOwner = (await api('POST', '/auth/session', { body: {} })).json
  await stopServer()
  const legacyPlayerPath = path.join(dataDir, 'players', `${legacyLayoutOwner.player.id}.json`)
  const legacyPlayer = JSON.parse(readFileSync(legacyPlayerPath, 'utf8'))
  const legacyHall = legacyPlayer.buildings.find(building => building.type === 'town_hall')
  const legacyCannon = legacyPlayer.buildings.find(building => building.type === 'cannon')
  const legacyBarracks = legacyPlayer.buildings.find(building => building.type === 'barracks')
  const legacyCamp = legacyPlayer.buildings.find(building => building.type === 'army_camp')
  legacyCannon.gridX = legacyHall.gridX
  legacyCannon.gridY = legacyHall.gridY
  legacyCamp.gridX = legacyBarracks.gridX
  legacyCamp.gridY = legacyBarracks.gridY
  legacyPlayer.shieldUntil = Date.now() + 24 * 60 * 60 * 1000
  legacyPlayer.obstacles.push({ id: 'stale-colliding-grass', type: 'grass_patch', gridX: legacyHall.gridX, gridY: legacyHall.gridY })
  legacyPlayer.obstacles.push({ id: 'valuable-colliding-rock', type: 'rock_small', gridX: legacyHall.gridX, gridY: legacyHall.gridY })
  // Simulate a village written before wilderness preserves existed. Startup
  // must move it intact rather than letting the legacy coordinate consume the
  // newly protected cell forever.
  legacyPlayer.plotX = 2
  legacyPlayer.plotY = 2
  // The restored Golem remains valid owned inventory, while removed,
  // generated, and unknown ids are scrubbed by startup sanitation.
  legacyPlayer.army = {
    sporelobber: 1,
    mantisstalker: 1,
    needleback: 1,
    riftdjinn: 1,
    golem: 1,
    skeleton: 4,
    romanwarrior: 4,
    removed_troop: 4
  }
  writeFileSync(legacyPlayerPath, JSON.stringify(legacyPlayer), 'utf8')
  const legacyEdgePath = path.join(dataDir, 'players', `${legacyEdgeOwner.player.id}.json`)
  const legacyEdgePlayer = JSON.parse(readFileSync(legacyEdgePath, 'utf8'))
  legacyEdgePlayer.plotX = 64
  legacyEdgePlayer.plotY = 64
  writeFileSync(legacyEdgePath, JSON.stringify(legacyEdgePlayer), 'utf8')
  await startServer()
  const afterRestart = (await api('GET', '/world', { token: a.token })).json
  ok(afterRestart.world.buildings.some(bl => bl.id === 'test_cannon_1'), 'base survives a full server restart')

  const migratedLegacySession = (await api('POST', '/auth/session', {
    body: { token: legacyLayoutOwner.token }
  })).json
  ok(migratedLegacySession.player.plotX !== 2 || migratedLegacySession.player.plotY !== 2,
    'startup migration frees legacy villages from permanent wilderness preserves')
  ok(JSON.stringify(migratedLegacySession.world.army) === JSON.stringify({ golem: 1 }),
    `startup sanitation preserves the restored Golem while dropping removed/generated/unknown ids (${JSON.stringify(migratedLegacySession.world.army)})`)
  for (const type of ['sporelobber', 'mantisstalker', 'needleback', 'riftdjinn']) {
    const removedTrain = await api('POST', '/army/train', {
      token: legacyLayoutOwner.token,
      body: { type, count: 1, requestId: `removed-${type}-train-rejected` }
    })
    ok(removedTrain.status === 404, `${type} cannot be trained after its end-to-end removal (${removedTrain.status})`)
  }
  const lockedGolemTrain = await api('POST', '/army/train', {
    token: legacyLayoutOwner.token,
    body: { type: 'golem', count: 1, requestId: 'restored-golem-needs-mystic-six' }
  })
  ok(lockedGolemTrain.status === 403,
    `the restored Golem requires its Mystic L6 unlock (${lockedGolemTrain.status})`)
  const golemDismiss = await api('POST', '/army/untrain', {
    token: legacyLayoutOwner.token,
    body: { type: 'golem', count: 1, requestId: 'restored-golem-dismiss' }
  })
  ok(golemDismiss.status === 200 && golemDismiss.json.army?.golem === undefined,
    `an existing restored Golem remains dismissible (${golemDismiss.status})`)
  ok(Object.keys((await api('GET', '/world', { token: legacyLayoutOwner.token })).json.world.army).length === 0,
    'dismissing the migrated Golem leaves a clean authoritative army')
  const migratedEdgeSession = (await api('POST', '/auth/session', {
    body: { token: legacyEdgeOwner.token }
  })).json
  ok(migratedEdgeSession.player.plotX === 64 && migratedEdgeSession.player.plotY === 64,
    'expandable regions preserve legacy edge villages without clipping their horizon')
  await api('POST', '/auth/logout', { token: legacyEdgeOwner.token })

  await api('POST', '/resources/apply', {
    token: legacyLayoutOwner.token,
    body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'legacy-layout-ore' }
  })
  let legacyWorld = (await api('GET', '/world', { token: legacyLayoutOwner.token })).json.world
  ok(!legacyWorld.obstacles.some(obstacle => obstacle.id === 'stale-colliding-grass'),
    'startup migration removes only stale obstacles colliding with current footprints')
  ok(legacyWorld.obstacles.some(obstacle => obstacle.id === 'valuable-colliding-rock'),
    'startup migration preserves valuable legacy obstacles even when footprints overlap')
  const upgradedLegacy = await api('POST', '/world/save', {
    token: legacyLayoutOwner.token,
    body: {
      world: {
        ...legacyWorld,
        buildings: legacyWorld.buildings.map(building => building.id === legacyCannon.id ? { ...building, level: 2 } : building)
      },
      requestId: 'legacy-collision-upgrade'
    }
  })
  ok(upgradedLegacy.status === 200, 'an upgrade may preserve exact pre-existing building collision signatures')
  legacyWorld = upgradedLegacy.json.world
  const shiftedLegacyPair = await api('POST', '/world/save', {
    token: legacyLayoutOwner.token,
    body: {
      world: {
        ...legacyWorld,
        buildings: legacyWorld.buildings.map(building =>
          building.id === legacyHall.id || building.id === legacyCannon.id
            ? { ...building, gridX: 18, gridY: 18 }
            : building)
      },
      requestId: 'legacy-collision-shift-pair'
    }
  })
  ok(shiftedLegacyPair.status === 400,
    'a grandfathered colliding pair cannot move together to a different tile')
  const movedLegacy = await api('POST', '/world/save', {
    token: legacyLayoutOwner.token,
    body: {
      world: {
        ...legacyWorld,
        buildings: legacyWorld.buildings.map(building => building.id === legacyCannon.id ? { ...building, gridX: 0, gridY: 18 } : building)
      },
      requestId: 'legacy-collision-move-away'
    }
  })
  ok(movedLegacy.status === 200, 'a move may reduce a pre-existing building collision')
  legacyWorld = movedLegacy.json.world
  const reintroducedCollision = await api('POST', '/world/save', {
    token: legacyLayoutOwner.token,
    body: {
      world: {
        ...legacyWorld,
        buildings: legacyWorld.buildings.map(building => building.id === legacyCannon.id
          ? { ...building, gridX: legacyHall.gridX, gridY: legacyHall.gridY }
          : building)
      },
      requestId: 'legacy-collision-reintroduced'
    }
  })
  ok(reintroducedCollision.status === 400, 'a resolved legacy collision cannot be introduced again at a later save')
  const deletedLegacy = await api('POST', '/world/save', {
    token: legacyLayoutOwner.token,
    body: {
      world: { ...legacyWorld, buildings: legacyWorld.buildings.filter(building => building.id !== legacyCamp.id) },
      requestId: 'legacy-collision-delete'
    }
  })
  ok(deletedLegacy.status === 200, 'deleting an object may reduce another pre-existing building collision')

  // A stale client (loaded before the migration ran) honestly resends the
  // grass the migration dropped. The save must shed that ghost grass and
  // commit the edit — never bounce wholesale, or the client loops on
  // "layout collision — changes reverted" for every subsequent action.
  const staleClientWorld = deletedLegacy.json.world
  const staleClientSave = await api('POST', '/world/save', {
    token: legacyLayoutOwner.token,
    body: {
      world: {
        ...staleClientWorld,
        buildings: staleClientWorld.buildings.filter(building => building.id !== legacyBarracks.id),
        obstacles: [
          ...staleClientWorld.obstacles,
          { id: 'stale-colliding-grass', type: 'grass_patch', gridX: legacyHall.gridX, gridY: legacyHall.gridY }
        ]
      },
      requestId: 'stale-client-ghost-grass'
    }
  })
  ok(staleClientSave.status === 200, 'a stale client resending migration-dropped grass still saves (ghost grass shed, not bounced)')
  ok(!staleClientSave.json.world.obstacles.some(obstacle => obstacle.id === 'stale-colliding-grass'),
    'shed ghost grass does not re-enter the authoritative base')
  ok(!staleClientSave.json.world.buildings.some(building => building.id === legacyBarracks.id),
    'the edit carried alongside ghost grass still lands')

  // --- Resources ---
  console.log('\nResources:')
  const balance0 = afterRestart.world.resources.gold
  const spend = (await api('POST', '/resources/apply', { token: a.token, body: { delta: -100, requestId: 'spend-1' } })).json
  ok(spend.applied === true && spend.gold <= balance0 - 100 + 5, 'spending deducts balance')
  const spendReplay = (await api('POST', '/resources/apply', { token: a.token, body: { delta: -100, requestId: 'spend-1' } })).json
  ok(spendReplay.gold >= spend.gold, 'duplicate requestId does not double-spend')
  const zeroDelta = (await api('POST', '/resources/apply', { token: a.token, body: { delta: 0, requestId: 'zero-delta' } })).json
  ok(zeroDelta.applied === false && zeroDelta.revision === spendReplay.revision, 'a zero resource delta does not dirty or revise the player')
  const overdraft = (await api('POST', '/resources/apply', { token: a.token, body: { delta: -99999999 } })).json
  ok(overdraft.applied === false, 'overdraft is refused')
  const staleSave = await api('POST', '/world/save', { token: a.token, body: { world: afterRestart.world, requestId: 'stale-device-save' } })
  ok(staleSave.status === 409 && staleSave.json?.code === 'STALE_REVISION' && staleSave.json?.currentRevision > afterRestart.world.revision && staleSave.json?.world,
    'a stale device gets a structured conflict plus the authoritative world')

  // --- Attack lifecycle ---
  console.log('\nAttack:')
  await armWarriors(b.token, 50, 'arm-initial-battle')
  const aBalanceBefore = (await api('GET', '/world', { token: a.token })).json.world.resources.gold
  const bBalanceBefore = (await api('GET', '/world', { token: b.token })).json.world.resources.gold

  const attack = (await api('POST', '/attacks/matchmake', { token: b.token, body: { requestId: 'initial-matchmake' } })).json
  ok(attack.attackId && attack.world?.ownerId === a.player.id, 'attack start returns a snapshot of the defender base')
  ok(Number.isInteger(attack.target?.x) && Number.isInteger(attack.target?.y) && attack.target.plotVersion >= 1,
    'every selected opponent is anchored to a versioned world plot')
  const freshAccountFocus = await api('GET', `/map?x=${attack.target.x}&y=${attack.target.y}&r=1`, { token: b.token })
  ok(freshAccountFocus.status === 200 && freshAccountFocus.json.plots.length === 9,
    'an active target grants even a fresh account the local 3x3 battlefield context')
  ok(attack.lootCap === Math.floor(aBalanceBefore * 0.2), 'loot cap is 20% of the defender balance')
  ok(attack.world.resources.gold === attack.lootCap && attack.world.army === undefined
    && attack.world.population === undefined && Number.isInteger(attack.world.life?.population),
    'combat snapshots expose raidable caps and public resident count, never balances, staffing or army')
  const attackStartRetry = (await api('POST', '/attacks/matchmake', { token: b.token, body: { requestId: 'initial-matchmake' } })).json
  ok(attackStartRetry.attackId === attack.attackId && attackStartRetry.world.ownerId === attack.world.ownerId,
    'retrying matchmake with one requestId returns the same persisted attack')

  const second = await api('POST', '/attacks/start', { token: b.token, body: { targetId: a.player.id } })
  ok(second.status === 409, 'a base cannot be attacked twice at once')
  const parallelVictim = (await api('POST', '/auth/session')).json
  const parallel = await api('POST', '/attacks/start', { token: b.token, body: { targetId: parallelVictim.player.id } })
  ok(parallel.status === 409, 'an attacker cannot reserve the same army in two simultaneous attacks')
  const mutateReservedArmy = await api('POST', '/army/untrain', { token: b.token, body: { type: 'warrior', count: 1, requestId: 'untrain-during-attack' } })
  ok(mutateReservedArmy.status === 409, 'reserved troops cannot be untrained during a live attack')
  ok((await api('POST', '/attacks/bot-start', { token: b.token, body: { requestId: 'bot-during-pvp' } })).status === 409,
    'a bot raid cannot start while the army is reserved for PvP')
  ok((await api('POST', '/map/relocate', { token: b.token, body: {} })).status === 409,
    'an attacker cannot relocate during a live PvP session')

  const selfAttack = await api('POST', '/attacks/start', { token: a.token, body: { targetId: a.player.id } })
  ok(selfAttack.status === 400, 'self-attack is rejected')

  const pendingIncoming = (await api('GET', '/attacks/incoming', { token: a.token })).json
  ok(!pendingIncoming.sessions?.some(s => s.attackId === attack.attackId), 'pre-deployment selection does not lock or alert the defender')

  const frames = validBattleFrames(attack, 50, 30, 100)
  const firstRoot = frames[0].troops[0]
  const commanded = await api('POST', '/attacks/commands', {
    token: b.token,
    body: {
      attackId: attack.attackId,
      commands: [{
        type: 'DEPLOY',
        commandId: `deploy_${firstRoot.id}`,
        sequence: 1,
        troopInstanceId: firstRoot.id,
        troopType: firstRoot.type,
        gridX: firstRoot.gridX,
        gridY: firstRoot.gridY
      }]
    }
  })
  ok(commanded.status === 200 && commanded.json.phase === 'ACTIVE' && commanded.json.lastCommandSequence === 1,
    'a sequenced deploy command engages the authoritative attack state machine')
  const rejectedCommandBatch = await api('POST', '/attacks/commands', {
    token: b.token,
    body: {
      attackId: attack.attackId,
      commands: [
        { type: 'SURRENDER', commandId: 'batch-command-2', sequence: 2 },
        { type: 'SURRENDER', commandId: 'batch-command-3', sequence: 3 }
      ]
    }
  })
  ok(rejectedCommandBatch.status === 400,
    'multi-command requests are rejected before any partial authority mutation')
  const pushed = (await api('POST', '/attacks/frames', { token: b.token, body: { attackId: attack.attackId, frames } })).json
  ok(pushed.frameCount === 30, 'frame batch is appended')

  const incoming = (await api('GET', '/attacks/incoming', { token: a.token })).json
  ok(incoming.sessions?.some(s => s.attackId === attack.attackId), 'first validated deployment locks and alerts the defender')
  ok((await api('POST', '/map/relocate', { token: a.token, body: {} })).status === 409,
    'a deployed PvP victim cannot relocate out from under the attack')

  const framesByVictim = await api('POST', '/attacks/frames', { token: a.token, body: { attackId: attack.attackId, frames } })
  ok(framesByVictim.status === 403, 'only the attacker can push frames')

  const claimedLoot = 999999999
  await new Promise(resolve => setTimeout(resolve, 6000))
  const end = (await api('POST', '/attacks/end', {
    token: b.token,
    body: { attackId: attack.attackId, destruction: 72, goldLooted: claimedLoot, status: 'finished' }
  })).json
  ok(end.lootApplied > 0 && end.lootApplied <= attack.lootCap, 'settlement ignores the client claim and derives loot from elapsed validated combat')
  ok(end.trophyDelta > 0 && end.attackerTrophies === end.trophyDelta, 'winning awards trophies')

  const endReplay = (await api('POST', '/attacks/end', {
    token: b.token,
    body: { attackId: attack.attackId, destruction: 72, goldLooted: claimedLoot }
  })).json
  ok(endReplay.lootApplied === end.lootApplied && endReplay.oreApplied === end.oreApplied &&
    endReplay.foodApplied === end.foodApplied && endReplay.attackerBalance === end.attackerBalance &&
    Number.isFinite(endReplay.attackerOre) && Number.isFinite(endReplay.attackerFood),
    'ending twice returns the complete authoritative settlement without applying twice')

  const aBalanceAfter = (await api('GET', '/world', { token: a.token })).json.world.resources.gold
  const bBalanceAfter = (await api('GET', '/world', { token: b.token })).json.world.resources.gold
  ok(aBalanceAfter <= aBalanceBefore - end.lootApplied + 10, 'defender lost the loot')
  ok(bBalanceAfter >= bBalanceBefore + end.lootApplied - 1 && bBalanceAfter <= bBalanceBefore + end.lootApplied + 10,
    'attacker gained exactly the loot (plus small accrual)')

  // --- Notifications & replay ---
  console.log('\nNotifications & replay:')
  const notifs = (await api('GET', '/notifications', { token: a.token })).json
  ok(notifs.items?.length === 1 && notifs.items[0].attackId === attack.attackId, 'defender got exactly one notification')
  ok(notifs.unread === 1, 'notification starts unread')
  await api('POST', '/notifications/read', { token: a.token })
  ok((await api('GET', '/notifications', { token: a.token })).json.unread === 0, 'mark-read works')

  const t0 = performance.now()
  const replay = (await api('GET', `/replays/${attack.attackId}`, { token: a.token })).json
  const replayMs = performance.now() - t0
  ok(replay.replay?.frames?.length === 30 && replay.replay.enemyWorld?.buildings?.length > 0,
    'one request returns the complete replay')
  ok(replayMs < 100, `replay fetch is instant (${replayMs.toFixed(1)}ms)`)
  ok(replay.replay.finalResult?.goldLooted === end.lootApplied, 'replay carries the final result')

  const stranger = (await api('POST', '/auth/session')).json
  const forbidden = await api('GET', `/replays/${attack.attackId}`, { token: stranger.token })
  ok(forbidden.status === 403, 'non-participants cannot fetch a replay')

  // --- Leaderboard, scout, rename ---
  console.log('\nSocial:')
  const renamed = (await api('POST', '/player/rename', { token: b.token, body: { name: 'TestRaider' } })).json
  ok(renamed.player?.username === 'TestRaider', 'rename works')
  const badName = await api('POST', '/player/rename', { token: b.token, body: { name: 'x' } })
  ok(badName.status === 400, 'too-short name rejected')

  // Village banner: bounded heraldry choice, public in scout snapshots.
  const bannerBefore = (await api('GET', `/players/${b.player.id}/world`, { token: b.token })).json
  ok(bannerBefore.world?.banner === undefined, 'a fresh village has no explicit banner (identity default)')
  const bannerSet = (await api('POST', '/player/banner', { token: b.token, body: { banner: { palette: 3, emblem: 4, pattern: 2 } } })).json
  ok(bannerSet.banner?.palette === 3 && bannerSet.banner?.emblem === 4 && bannerSet.banner?.pattern === 2, 'banner choice is accepted and echoed')
  const bannerBad = await api('POST', '/player/banner', { token: b.token, body: { banner: { palette: 99, emblem: 0 } } })
  ok(bannerBad.status === 400, 'out-of-range banner axes are rejected')
  const bannerMissing = await api('POST', '/player/banner', { token: b.token, body: {} })
  ok(bannerMissing.status === 400, 'a banner call without a payload never silently resets')
  const bannerScout = (await api('GET', `/players/${b.player.id}/world`, { token: b.token })).json
  ok(bannerScout.world?.banner?.palette === 3 && bannerScout.world?.banner?.emblem === 4,
    'the chosen banner is public in scout snapshots')
  ok(Number(bannerScout.world?.revision) > Number(bannerBefore.world?.revision),
    'banner changes bump the public appearance revision (postcards refresh)')
  const bannerOwn = (await api('GET', '/world', { token: b.token })).json
  ok(bannerOwn.world?.banner?.palette === 3, 'the owner world payload carries the banner')
  const bannerReset = (await api('POST', '/player/banner', { token: b.token, body: { banner: null } })).json
  ok(bannerReset.banner === null, 'explicit null returns the village to its identity default')
  const bannerAfterReset = (await api('GET', `/players/${b.player.id}/world`, { token: b.token })).json
  ok(bannerAfterReset.world?.banner === undefined, 'a reset banner disappears from public snapshots')

  const lb = (await api('GET', '/leaderboard', { token: a.token })).json
  ok(lb.players?.[0]?.username === 'TestRaider', 'leaderboard is sorted by trophies')
  const leaderboardTarget = lb.players.find(player => player.id === a.player.id)
  ok(Number.isFinite(leaderboardTarget.plotX) && typeof leaderboardTarget.inScoutRange === 'boolean',
    'leaderboard rows expose coordinates and truthful scout-range authorization')

  const scout = (await api('GET', `/players/${a.player.id}/world`, { token: b.token })).json
  ok(scout.error && /watchtower sight/.test(scout.error), 'a blind account cannot scout an arbitrary player id')
  const selfScout = (await api('GET', `/players/${b.player.id}/world`, { token: b.token })).json
  ok(selfScout.world?.ownerId === b.player.id && selfScout.world.resources === undefined && selfScout.world.army === undefined,
    'public scout snapshots omit private resources and army')
  ok((await api('POST', '/attacks/start', { token: b.token, body: { targetId: parallelVictim.player.id } })).status === 403,
    'targeted attack IDs cannot bypass earned watchtower sight')

  // --- Aborted attack ---
  console.log('\nAbort:')
  await armWarriors(stranger.token, 1, 'arm-abort-stranger')
  const abort = (await api('POST', '/attacks/matchmake', { token: stranger.token })).json
  ok(abort.attackId, 'matchmaking finds an opponent')
  const aborted = (await api('POST', '/attacks/end', {
    token: stranger.token,
    body: { attackId: abort.attackId, destruction: 0, goldLooted: 0, status: 'aborted' }
  })).json
  ok(aborted.lootApplied === 0 && aborted.trophyDelta === 0, 'walking away settles as a harmless abort')

  // Regression: an aborted no-op attack must NOT notify the defender or keep a junk replay.
  // (Fresh victim: earlier finished battles legitimately shield their defenders now.)
  const abortee = (await api('POST', '/auth/session', { body: {} })).json
  const targeted = (await api('POST', '/attacks/matchmake', { token: stranger.token, body: { requestId: 'noop-matchmake' } })).json
  const targetAccount = [a, b, parallelVictim, abortee].find(account => account.player.id === targeted.world.ownerId)
  const aNotifsBefore = targetAccount ? (await api('GET', '/notifications', { token: targetAccount.token })).json.items.length : 0
  await api('POST', '/attacks/end', { token: stranger.token, body: { attackId: targeted.attackId, destruction: 0, goldLooted: 0, status: 'aborted' } })
  const aNotifsAfter = targetAccount ? (await api('GET', '/notifications', { token: targetAccount.token })).json.items.length : 0
  ok(aNotifsAfter === aNotifsBefore, 'no-op abort does not spam the defender with a false raid notification')
  ok((await api('GET', `/replays/${targeted.attackId}`, { token: stranger.token })).status === 404, 'no-op abort discards the junk replay')
  const afterAbortMatch = (await api('POST', '/attacks/matchmake', {
    token: stranger.token,
    body: {
      requestId: 'after-noop-matchmake',
      excludeTargetId: targeted.world.ownerId
    }
  })).json
  ok(afterAbortMatch.attackId && afterAbortMatch.world.ownerId !== targeted.world.ownerId,
    'matchmaking is immediately available after a no-op abort and skips the previous target')
  await api('POST', '/attacks/end', { token: stranger.token, body: { attackId: afterAbortMatch.attackId, status: 'aborted' } })

  // Regression: rejected overdraft must not consume its idempotency key.
  const stBal = (await api('GET', '/world', { token: stranger.token })).json.world.resources.gold
  const rej1 = (await api('POST', '/resources/apply', { token: stranger.token, body: { delta: -(stBal + 5000), requestId: 'rk-1' } })).json
  ok(rej1.applied === false, 'overdraft rejected')
  const ok2 = (await api('POST', '/resources/apply', { token: stranger.token, body: { delta: -10, requestId: 'rk-1' } })).json
  ok(ok2.applied === true && ok2.gold <= stBal - 10 + 5, 'a later spend reusing that requestId is NOT treated as a duplicate')

  // --- Ore & food (economy-sim groundwork) ---
  console.log('\nOre & food:')
  const resWorld = (await api('GET', '/world', { token: a.token })).json.world
  ok(Number.isFinite(resWorld.resources.ore) && Number.isFinite(resWorld.resources.food),
    'world exposes ore and food stocks')
  const oreBefore = resWorld.resources.ore
  const oreGrant = (await api('POST', '/resources/apply', { token: a.token, body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'ore-1' } })).json
  ok(oreGrant.applied === true && oreGrant.ore === oreBefore + 100, 'granting ore raises the ore stock')
  const oreReplay = (await api('POST', '/resources/apply', { token: a.token, body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'ore-1' } })).json
  ok(oreReplay.ore === oreGrant.ore, 'duplicate ore requestId does not double-apply')
  const foodOverdraft = (await api('POST', '/resources/apply', { token: a.token, body: { delta: -999999, resource: 'food' } })).json
  ok(foodOverdraft.applied === false, 'food overdraft is refused')
  const solUntouched = (await api('GET', '/world', { token: a.token })).json.world.resources
  ok(solUntouched.ore === oreGrant.ore && Number.isFinite(solUntouched.gold),
    'ore/food changes never touch the gold balance')

  // --- Economy buildings: storage caps + mine/farm persistence ---
  console.log('\nEconomy buildings:')
  const econWorld = (await api('GET', '/world', { token: a.token })).json.world
  ok(econWorld.storage && econWorld.storage.ore > 0 && econWorld.storage.food > 0,
    'world exposes storage capacities')
  const capsBefore = econWorld.storage
  // The save is a purchase now — fund the account before it goes shopping.
  await api('POST', '/resources/apply', { token: a.token, body: { delta: 20000, reason: 'debug_grant', requestId: 'fund-econ-gold' } })
  await api('POST', '/resources/apply', { token: a.token, body: { delta: 150, resource: 'ore', reason: 'debug_grant', requestId: 'fund-econ-ore' } })
  const fundedEconWorld = (await api('GET', '/world', { token: a.token })).json.world
  const withEcon = {
    ...fundedEconWorld,
    buildings: [
      ...fundedEconWorld.buildings,
      { id: 'econ_storage', type: 'storage', gridX: 18, gridY: 2, level: 1 },
      { id: 'econ_mine', type: 'mine', gridX: 21, gridY: 2, level: 1 },
      { id: 'econ_farm', type: 'farm', gridX: 18, gridY: 5, level: 1 }
    ]
  }
  const econSaved = (await api('POST', '/world/save', { token: a.token, body: { world: withEcon, requestId: 'econ-save-1' } })).json
  ok(econSaved.world.buildings.some(bl => bl.id === 'econ_mine') && econSaved.world.buildings.some(bl => bl.id === 'econ_farm'),
    'mine and farm pass validation and persist')
  ok(econSaved.world.storage.ore === capsBefore.ore + 250 && econSaved.world.storage.food === capsBefore.food + 250,
    'a storehouse raises both the ore and food caps')
  const debugStock = (await api('POST', '/auth/session', { body: {} })).json
  const debugBefore = (await api('GET', '/world', { token: debugStock.token })).json.world
  const debugOre = (await api('POST', '/resources/apply', { token: debugStock.token, body: { delta: 10_000, resource: 'ore', reason: 'debug_grant', requestId: 'debug-stock-ore' } })).json
  const debugFood = (await api('POST', '/resources/apply', { token: debugStock.token, body: { delta: 10_000, resource: 'food', reason: 'debug_grant', requestId: 'debug-stock-food' } })).json
  const debugPersisted = (await api('GET', '/world', { token: debugStock.token })).json.world
  ok(debugOre.ore === debugBefore.resources.ore + 10_000 && debugOre.ore > debugBefore.storage.ore,
    'debug ore grants exceed storage capacity on the backend')
  ok(debugFood.food === debugBefore.resources.food + 10_000 && debugFood.food > debugBefore.storage.food,
    'debug food grants exceed storage capacity on the backend')
  ok(debugPersisted.resources.ore === debugOre.ore && debugPersisted.resources.food === debugFood.food,
    'over-cap debug resources survive the following request and world materialization')

  // --- Population (economy-sim groundwork) ---
  console.log('\nPopulation:')
  const popWorld = (await api('GET', '/world', { token: a.token })).json.world
  ok(popWorld.population && popWorld.population.count >= 3, 'world exposes a server-authoritative population count')
  ok(Number.isFinite(popWorld.population.capacity) && popWorld.population.capacity >= popWorld.population.count,
    'population capacity is derived from the layout and bounds the count')
  const popCapBefore = popWorld.population.capacity
  // A second army camp: legal under the shop cap, +1 housing, zero workers —
  // so the workforce assertion below stays untouched.
  await api('POST', '/resources/apply', { token: a.token, body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'fund-pop-ore' } })
  const fundedPopWorld = (await api('GET', '/world', { token: a.token })).json.world
  const moreHousing = { ...fundedPopWorld, buildings: [...fundedPopWorld.buildings, { id: 'pop_camp', type: 'army_camp', gridX: 20, gridY: 20, level: 1 }] }
  const popSaved = (await api('POST', '/world/save', { token: a.token, body: { world: moreHousing, requestId: 'pop-save-1' } })).json
  ok(popSaved.world.population.capacity === popCapBefore + 1, 'adding housing raises the population capacity')

  // Workforce: the mine + farm added earlier need 4 hands.
  const wf = popSaved.world.population
  ok(wf.workersNeeded === 4, `mine + farm need 4 workers (${wf.workersNeeded})`)
  const expectedStaffing = Math.min(1, wf.count / wf.workersNeeded)
  ok(Math.abs(wf.staffing - expectedStaffing) < 0.001,
    `staffing = population/needed, capped at 1 (${wf.staffing.toFixed(2)} for ${wf.count}/${wf.workersNeeded})`)

  // --- Username/password accounts ---
  console.log('\nAccounts:')
  const guest = (await api('POST', '/auth/session')).json
  ok(guest.player.registered === false, 'a fresh guest is not registered')
  guest.world.buildings.push({ id: 'acct_cannon', type: 'cannon', gridX: 4, gridY: 4, level: 1 })
  await api('POST', '/world/save', { token: guest.token, body: { world: guest.world, requestId: 'acct-save-1' } })

  const shortPw = await api('POST', '/auth/register', { token: guest.token, body: { username: 'AcctTester', password: 'short' } })
  ok(shortPw.status === 400, 'too-short password is rejected')
  const badRegName = await api('POST', '/auth/register', { token: guest.token, body: { username: 'x!', password: 'hunter2hunter2' } })
  ok(badRegName.status === 400, 'invalid username is rejected')

  const reg = (await api('POST', '/auth/register', { token: guest.token, body: { username: 'AcctTester', password: 'hunter2hunter2' } })).json
  ok(reg.player?.registered === true && reg.player.username === 'AcctTester', 'registering upgrades the guest account')
  const stillWorks = (await api('GET', '/world', { token: guest.token })).json
  ok(stillWorks.world.buildings.some(bl => bl.id === 'acct_cannon'), 'the existing village survives registration untouched')

  const dupUser = await api('POST', '/auth/register', { token: b.token, body: { username: 'accttester', password: 'hunter2hunter2' } })
  ok(dupUser.status === 409, 'a taken username (case-insensitive) cannot be registered twice')
  const reReg = await api('POST', '/auth/register', { token: guest.token, body: { username: 'Другой', password: 'hunter2hunter2' } })
  ok(reReg.status !== 200, 'an already-registered account cannot register again')

  const wrongPw = await api('POST', '/auth/login', { body: { username: 'AcctTester', password: 'wrong-password' } })
  ok(wrongPw.status === 401, 'wrong password is rejected')
  const noAcct = await api('POST', '/auth/login', { body: { username: 'NoSuchPlayer', password: 'whatever123' } })
  ok(noAcct.status === 404, 'unknown username is rejected')

  // "New device": no prior token, log in by username + password.
  const device2 = (await api('POST', '/auth/login', { body: { username: 'AcctTester', password: 'hunter2hunter2' } })).json
  ok(device2.token && device2.token !== guest.token, 'login issues a fresh session token')
  ok(device2.player.id === guest.player.id, 'login lands on the SAME account')
  ok(device2.world.buildings.some(bl => bl.id === 'acct_cannon'), 'login returns the saved village')
  const bothWork = (await api('GET', '/world', { token: guest.token })).status === 200 &&
    (await api('GET', '/world', { token: device2.token })).status === 200
  ok(bothWork, 'both devices stay signed in simultaneously')
  const sameNameRevision = (await api('GET', '/world', { token: guest.token })).json.world.revision
  await api('POST', '/player/rename', { token: guest.token, body: { name: 'AcctTester' } })
  ok((await api('GET', '/world', { token: guest.token })).json.world.revision === sameNameRevision,
    'renaming to the exact current name is a semantic no-op')

  await armWarriors(guest.token, 1, 'cross-device-arm')
  const deviceRaid = (await api('POST', '/attacks/matchmake', {
    token: guest.token,
    body: { requestId: 'cross-device-start' }
  })).json
  const ownerView = (await api('GET', '/attacks/active', { token: guest.token })).json.session
  const otherDeviceView = (await api('GET', '/attacks/active', { token: device2.token })).json.session
  ok(ownerView?.attackId === deviceRaid.attackId && ownerView.ownedByCurrentSession === true,
    'active-outgoing recovery recognizes the device that opened the raid')
  ok(otherDeviceView?.attackId === deviceRaid.attackId && otherDeviceView.ownedByCurrentSession === false,
    'another signed-in device sees the lock without impersonating its owner')
  const takeover = (await api('POST', '/attacks/active/abort', { token: device2.token })).json
  ok(takeover.aborted === true && takeover.kind === 'pvp', 'an explicit second-device takeover closes the orphaned raid')
  ok((await api('GET', '/attacks/active', { token: guest.token })).json.session === null,
    'active-outgoing lookup clears after takeover')

  await api('POST', '/auth/logout', { token: device2.token })
  ok((await api('GET', '/world', { token: device2.token })).status === 401, 'logout revokes that session token')
  ok((await api('GET', '/world', { token: guest.token })).status === 200, 'other sessions survive a logout')

  // Rename collision protection for registered names.
  const renameSteal = await api('POST', '/player/rename', { token: b.token, body: { name: 'ACCTTESTER' } })
  ok(renameSteal.status === 409, 'renaming onto a registered username is rejected')

  // Accounts must survive a full server restart (tokens, password, username index).
  await stopServer()
  await startServer()
  const afterRestart2 = (await api('POST', '/auth/login', { body: { username: 'AcctTester', password: 'hunter2hunter2' } })).json
  ok(afterRestart2.player?.id === guest.player.id, 'login works after a full server restart')
  ok(afterRestart2.world.buildings.some(bl => bl.id === 'acct_cannon'), 'village is intact after restart + login')
  ok((await api('GET', '/world', { token: guest.token })).status === 200, 'pre-restart session tokens still work')
  const durableBattle = await api('GET', `/replays/${attack.attackId}`, { token: a.token })
  const durableNotifications = (await api('GET', '/notifications', { token: a.token })).json.items
  ok(durableBattle.status === 200 && durableBattle.json.replay.finalResult.goldLooted === end.lootApplied,
    'settled replay outcome remains durable across restart')
  ok(durableNotifications.filter(item => item.attackId === attack.attackId).length === 1,
    'settlement recovery never duplicates or loses its defender notification')

  // Brute-force brake: hammer wrong passwords, then expect a lockout.
  for (let i = 0; i < 8; i++) {
    await api('POST', '/auth/login', { body: { username: 'AcctTester', password: `nope-${i}` } })
  }
  const locked = await api('POST', '/auth/login', { body: { username: 'AcctTester', password: 'hunter2hunter2' } })
  ok(locked.status === 429, 'repeated failed logins temporarily lock the account')
  const otherAddressLogin = await api('POST', '/auth/login', {
    body: { username: 'AcctTester', password: 'hunter2hunter2' },
    headers: { 'X-Forwarded-For': '198.51.100.20' }
  })
  ok(otherAddressLogin.status === 200, 'one address cannot globally lock a username for every legitimate device')
  let rotatedLogin = null
  for (let i = 0; i <= 30; i++) {
    rotatedLogin = await api('POST', '/auth/login', {
      body: { username: `Rotate${i}`, password: 'definitely-wrong' },
      headers: { 'X-Forwarded-For': '198.51.100.33' }
    })
  }
  ok(rotatedLogin.status === 429, 'an address-wide login budget blocks username rotation before unbounded password hashing')

  // --- Global world map ---
  console.log('\nWorld map:')
  const m1 = await api('POST', '/auth/session', { body: {} })
  const m2 = await api('POST', '/auth/session', { body: {} })
  const p1 = m1.json.player
  const p2 = m2.json.player
  ok(Number.isFinite(p1.plotX) && Number.isFinite(p1.plotY), 'every account owns plot coordinates')
  ok(p1.plotX !== p2.plotX || p1.plotY !== p2.plotY, 'two accounts get distinct plots')

  // Sight is EARNED: before any watchtower, a village sees only itself.
  const blind = await api('GET', `/map?x=${p1.plotX}&y=${p1.plotY}&r=2`, { token: m1.json.token })
  ok(blind.json.plots.length === 1, 'without a watchtower the map shows only your own plot')
  // Give both scouts eyes (level-1 towers) before the neighbourhood tests.
  for (const [ix, acct] of [m1, m2].entries()) {
    await api('POST', '/resources/apply', { token: acct.json.token, body: { delta: 2000, reason: 'debug_grant', requestId: `eyes-g-${ix}` } })
    await api('POST', '/resources/apply', { token: acct.json.token, body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: `eyes-o-${ix}` } })
    const eyesWorld = (await api('GET', '/world', { token: acct.json.token })).json.world
    eyesWorld.buildings.push({ id: `eyes_${ix}`, type: 'watchtower', gridX: 2, gridY: 2, level: 1 })
    await api('POST', '/world/save', { token: acct.json.token, body: { world: eyesWorld, requestId: `eyes-save-${ix}` } })
  }

  const atlas = await api('GET', '/map/atlas', { token: m1.json.token })
  ok(atlas.status === 200 && atlas.json.players.some(p => p.me) && atlas.json.players.length >= 2, 'the atlas charts every settled chief, self included')
  ok(atlas.json.players.length <= 500 && atlas.json.window.maxX - atlas.json.window.minX <= 48,
    'atlas responses have a fixed coordinate window and player cap')
  const edgeGuest = (await api('POST', '/auth/session')).json
  const edgeMove = await api('POST', '/map/relocate', { token: edgeGuest.token, body: { x: 1000001, y: 1000001 } })
  ok(edgeMove.status === 400, 'out-of-world relocation coordinates are rejected instead of clamped to another plot')
  const clippedHorizonMove = await api('POST', '/map/relocate', { token: edgeGuest.token, body: { x: 63, y: 63 } })
  ok(clippedHorizonMove.status === 403,
    'valid distant region coordinates remain gated by earned watchtower sight')

  const mod3 = value => ((value % 3) + 3) % 3
  let everyAllocatableWindowHasPreserve = true
  for (let cy = -62; cy <= 62 && everyAllocatableWindowHasPreserve; cy++) {
    for (let cx = -62; cx <= 62; cx++) {
      let found = false
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (mod3(cx + dx) === 2 && mod3(cy + dy) === 2) { found = true; break }
        }
      }
      if (!found) { everyAllocatableWindowHasPreserve = false; break }
    }
  }
  ok(everyAllocatableWindowHasPreserve,
    'every allocatable village center has a protected plot in its full 3x3 horizon')

  const mapA = await api('GET', `/map?x=${p1.plotX}&y=${p1.plotY}&r=1`, { token: m1.json.token })
  ok(mapA.status === 200 && mapA.json.plots.length === 9, 'a level-1 watchtower opens the full 3x3 of plots')
  ok(mapA.json.me.x === p1.plotX && mapA.json.me.y === p1.plotY, 'map reports my own plot')
  ok(Math.abs(mapA.json.serverNow - Date.now()) < 15_000, 'map carries the shared server clock')
  const self = mapA.json.plots.find(q => q.x === p1.plotX && q.y === p1.plotY)
  ok(self?.kind === 'player' && self.ownerId === p1.id, 'my plot appears as mine on the map')
  ok(self?.world?.resources === undefined && self?.world?.army === undefined && Array.isArray(self?.world?.buildings),
    'map postcards include layout but omit private economy and army state')
  ok(self?.world?.life?.version === 1 && self.world.life.identity === p1.id
    && Number.isInteger(self.world.life.population) && self.world.life.population >= 0
    && Array.isArray(self.world.life.bornAt),
    'postcards carry compact server-authoritative resident identity and population')
  const preserve = mapA.json.plots.find(q => q.kind === 'empty' && q.settleable === false)
  ok(Boolean(preserve), 'every earned 3x3 window retains a permanent wilderness preserve')
  ok((await api('POST', '/map/relocate', { token: m1.json.token, body: { x: preserve.x, y: preserve.y } })).status === 409,
    'permanent wilderness preserves cannot be consumed by relocation')
  const known = mapA.json.plots.filter(q => q.kind === 'player').map(q => `${q.x},${q.y}:${q.ownerId}:${q.revision}`).join(';')
  const unchangedMap = await api('GET', `/map?x=${p1.plotX}&y=${p1.plotY}&r=1&known=${encodeURIComponent(known)}`, { token: m1.json.token })
  ok(unchangedMap.json.plots.filter(q => q.kind === 'player').every(q => q.world === undefined),
    'known plot revisions suppress unchanged postcard payloads')
  const farMap = await api('GET', `/map?x=${p1.plotX + 10}&y=${p1.plotY + 10}&r=0`, { token: m1.json.token })
  ok(farMap.status === 403, 'arbitrary far map centers are rejected outside earned sight')
  ok((await api('GET', '/map?x=1000001&y=1000001&r=1', { token: m1.json.token })).status === 400,
    'out-of-world map centers are rejected rather than normalized')

  const mapB = await api('GET', `/map?x=${p1.plotX}&y=${p1.plotY}&r=1`, { token: m1.json.token })
  const botsA = mapA.json.plots.filter(q => q.kind === 'bot').map(q => `${q.x},${q.y}:${q.seed}`)
  const botsB = mapB.json.plots.filter(q => q.kind === 'bot').map(q => `${q.x},${q.y}:${q.seed}`)
  ok(botsA.length > 0, 'wilderness near the origin hosts bot villages')
  ok(botsA.join('|') === botsB.join('|'), 'bot plots are stable across repeated server map generation')

  // The level-2 watchtower opens the full 5x5 horizon (the upgrade's ore
  // bill needs a storehouse first — the cap gates it deliberately).
  await api('POST', '/resources/apply', { token: m1.json.token, body: { delta: 9000, reason: 'debug_grant', requestId: 'wt-g' } })
  await api('POST', '/resources/apply', { token: m1.json.token, body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'wt-o0' } })
  const wtWorld = (await api('GET', '/world', { token: m1.json.token })).json.world
  wtWorld.buildings.push({ id: 'wt_store', type: 'storage', gridX: 6, gridY: 2, level: 1 })
  await api('POST', '/world/save', { token: m1.json.token, body: { world: wtWorld, requestId: 'wt-save-1' } })
  await api('POST', '/resources/apply', { token: m1.json.token, body: { delta: 400, resource: 'ore', reason: 'debug_grant', requestId: 'wt-o' } })
  const wtUp = (await api('GET', '/world', { token: m1.json.token })).json.world
  const upgraded2 = { ...wtUp, buildings: wtUp.buildings.map(b => b.type === 'watchtower' ? { ...b, level: 2 } : b) }
  await api('POST', '/world/save', { token: m1.json.token, body: { world: upgraded2, requestId: 'wt-save-2' } })
  // Let the (scaled) upgrade clock mature and land before sight is measured.
  await new Promise(resolve => setTimeout(resolve, 600))
  await api('GET', '/world', { token: m1.json.token })
  const mid = await api('GET', `/map?x=${p1.plotX}&y=${p1.plotY}&r=2`, { token: m1.json.token })
  ok(mid.json.plots.length === 25, 'a level-2 watchtower opens the full 5x5 window')
  const edgeOfSight = await api('GET', `/map?x=${p1.plotX + 1}&y=${p1.plotY}&r=2`, { token: m1.json.token })
  ok(edgeOfSight.json.plots.length === 9, 'a non-home map center cannot expand its ring beyond the remaining sight budget')
  const wide = mid
  const roadTarget = wide.json.plots.find(plot => plot.kind === 'player' && plot.ownerId !== p1.id && !plot.shielded && !plot.underAttack)
  if (roadTarget) {
    await armWarriors(m1.json.token, 1, 'arm-road-focus')
    const roadAttack = (await api('POST', '/attacks/start', { token: m1.json.token, body: { targetId: roadTarget.ownerId, requestId: 'road-focus-start' } })).json
    const focusedRing = await api('GET', `/map?x=${roadTarget.x}&y=${roadTarget.y}&r=2`, { token: m1.json.token })
    ok(focusedRing.status === 200 && focusedRing.json.plots.length === 25,
      'an explicit in-sight active PvP target authorizes its full battle focus ring')
    await api('POST', '/attacks/end', { token: m1.json.token, body: { attackId: roadAttack.attackId, status: 'aborted' } })
  } else {
    ok(true, 'no unshielded road target was present in this deterministic test neighborhood')
  }

  // Relocation: settle a specific empty plot, then bounce off a taken one.
  const occupiedCamp = wide.json.plots.find(q => q.kind === 'bot')
  ok((await api('POST', '/map/relocate', { token: m1.json.token, body: { x: occupiedCamp.x, y: occupiedCamp.y } })).status === 409,
    'relocation cannot erase a deterministic bot camp')
  const empty = wide.json.plots.find(q => q.kind === 'empty' && q.settleable !== false)
  ok(Boolean(empty), 'there is wilderness to settle')
  const moved = await api('POST', '/map/relocate', { token: m1.json.token, body: { x: empty.x, y: empty.y } })
  ok(moved.status === 200 && moved.json.me.x === empty.x && moved.json.me.y === empty.y, 'relocating claims the chosen plot')
  const taken = await api('POST', '/map/relocate', { token: m2.json.token, body: { x: empty.x, y: empty.y } })
  ok([403, 409].includes(taken.status), 'relocating onto an unauthorized/taken plot is refused')
  const movedAtlas = (await api('GET', '/map/atlas', { token: m1.json.token })).json
  ok(!movedAtlas.players.some(player => player.me && player.x === p1.plotX && player.y === p1.plotY), 'the old plot is freed on the atlas')
  const beforeFrontier = (await api('POST', '/auth/session', { body: { token: m2.json.token } })).json.player
  const frontier = await api('POST', '/map/relocate', { token: m2.json.token, body: {} })
  ok(frontier.status === 200 && Number.isFinite(frontier.json.me.x), 'argless relocate settles the next frontier plot')
  ok(frontier.json.me.x !== beforeFrontier.plotX || frontier.json.me.y !== beforeFrontier.plotY,
    'argless relocate actually MOVES (never hands back the plot you just left)')

  // Live battles surface on the map.
  await armWarriors(m2.json.token, 6, 'arm-map-attacker')
  const atk = await matchmakeUntil(m2.json.token, m1.json.player.id, 'map-live')
  ok(atk.attackId, 'matchmade attack starts against the chosen map victim')
  await api('POST', '/attacks/frames', { token: m2.json.token, body: { attackId: atk.attackId, frames: validBattleFrames(atk, 6, 3, 100) } })
  const hot = await api('GET', `/map?x=${empty.x}&y=${empty.y}&r=0`, { token: m1.json.token })
  ok(hot.json.plots[0].underAttack === true && hot.json.plots[0].attackId === atk.attackId, 'a village under live attack is flagged on its home map')
  await api('POST', '/attacks/end', { token: m2.json.token, body: { attackId: atk.attackId, destruction: 0, goldLooted: 0 } })

  // Real battles stream frames; a frameless "finish" settles as a no-op by design.
  const streamFrames = async (token, attack, n = 3, destroyedPercent = 100, troopCount = 6) => {
    await api('POST', '/attacks/frames', { token, body: { attackId: attack.attackId, frames: validBattleFrames(attack, troopCount, n, destroyedPercent) } })
  }

  // --- Shields & revenge ---
  console.log('\nShields & revenge:')
  const sA = await api('POST', '/auth/session', { body: {} })
  const sB = await api('POST', '/auth/session', { body: {} })
  const sC = await api('POST', '/auth/session', { body: {} })

  // B raids A: the beaten defender gains a shield + a revenge right on B.
  await armWarriors(sB.json.token, 50, 'arm-shield-b')
  const raid1 = await matchmakeUntil(sB.json.token, sA.json.player.id, 'shield-raid')
  ok(raid1.attackId, 'matchmaking can authorize a remote unshielded village')
  await streamFrames(sB.json.token, raid1, 3, 100, 50)
  await new Promise(resolve => setTimeout(resolve, 2500))
  await api('POST', '/attacks/end', { token: sB.json.token, body: { attackId: raid1.attackId, destruction: 60, goldLooted: 0 } })
  const profA = await api('POST', '/auth/session', { body: { token: sA.json.token } })
  ok(profA.json.player.shieldUntil > Date.now(), 'a beaten defender is granted a shield')

  const blocked = await api('POST', '/attacks/start', { token: sC.json.token, body: { targetId: sA.json.player.id } })
  ok(blocked.status === 403, 'third parties bounce off the shield')

  // A's revenge right authorizes one explicit remote payback and is consumed.
  await armWarriors(sA.json.token, 50, 'arm-revenge-a')
  const matchmadeProbe = (await api('POST', '/attacks/matchmake', { token: sA.json.token, body: { requestId: 'revenge-matchmade-probe' } })).json
  await api('POST', '/attacks/end', { token: sA.json.token, body: { attackId: matchmadeProbe.attackId, status: 'aborted' } })
  const rev1 = await api('POST', '/attacks/start', { token: sA.json.token, body: { targetId: sB.json.player.id } })
  ok(rev1.status === 200, 'matchmaking does not consume the right needed for one explicit remote revenge')
  await streamFrames(sA.json.token, rev1.json, 3, 100, 50)
  const profA2 = await api('POST', '/auth/session', { body: { token: sA.json.token } })
  ok((profA2.json.player.shieldUntil ?? 0) <= Date.now(), 'marching out drops your own shield')
  await new Promise(resolve => setTimeout(resolve, 2500))
  await api('POST', '/attacks/end', { token: sA.json.token, body: { attackId: rev1.json.attackId, destruction: 95, goldLooted: 0 } })
  const profB = await api('POST', '/auth/session', { body: { token: sB.json.token } })
  ok(profB.json.player.shieldUntil > Date.now(), 'a 95% defeat grants a long shield')

  const blocked2 = await api('POST', '/attacks/start', { token: sC.json.token, body: { targetId: sB.json.player.id } })
  ok(blocked2.status === 403, 'the shielded raider cannot be re-farmed by others')
  const spent = await api('POST', '/attacks/start', { token: sA.json.token, body: { targetId: sB.json.player.id } })
  ok(spent.status === 403, 'the remote revenge right is consumed by the payback attack')


  const shieldMap = await api('GET', `/map?x=${sB.json.player.plotX}&y=${sB.json.player.plotY}&r=0`, { token: sB.json.token })
  ok(shieldMap.json.plots[0].shielded === true, 'the map flags shielded villages')

  const mm = await api('POST', '/attacks/matchmake', { token: sC.json.token })
  ok(mm.status !== 500, 'matchmake survives a world full of shields')

  // --- Core-rot regression: exploits and vestiges stay dead ---
  console.log('\nCore-rot regressions:')
  const rotA = (await api('POST', '/auth/session', { body: {} })).json
  const rotB = (await api('POST', '/auth/session', { body: {} })).json
  const emptyArmyStart = await api('POST', '/attacks/matchmake', { token: rotA.token, body: { requestId: 'empty-army-match' } })
  ok(emptyArmyStart.status === 409, 'an empty army cannot hold a victim in a pending live attack')

  // 1. Empty/fake replay frames do not constitute a battle.
  await armWarriors(rotB.token, 1, 'arm-rot-forgery')
  const forged = (await api('POST', '/attacks/matchmake', { token: rotB.token, body: { requestId: 'forged-match' } })).json
  const forgedTarget = forged.world.buildings.find(building => building.type !== 'wall')
  await api('POST', '/attacks/frames', { token: rotB.token, body: { attackId: forged.attackId, frames: [
    { t: 100, destruction: 100, goldLooted: 99999, buildings: [{ id: forgedTarget.id, health: 0, isDestroyed: true }], troops: [] },
    { t: 200, destruction: 100, goldLooted: 99999, buildings: [{ id: forgedTarget.id, health: 0, isDestroyed: true }], troops: [{ id: 'invented', type: 'golem', owner: 'PLAYER', health: 9000, maxHealth: 9000, gridX: 1, gridY: 1 }] }
  ] } })
  const forgeEnd = (await api('POST', '/attacks/end', { token: rotB.token, body: { attackId: forged.attackId, destruction: 100, goldLooted: 99999 } })).json
  ok(forgeEnd.lootApplied === 0 && forgeEnd.trophyDelta === 0, 'empty and invented-troop frames award no loot or trophies')
  const rotAProfile = (await api('POST', '/auth/session', { body: { token: rotA.token } })).json.player
  ok((rotAProfile.shieldUntil ?? 0) <= Date.now(), 'a frameless finish grants no shield (it never happened)')

  const instant = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(instant.token, 50, 'arm-instant-forgery')
  const instantAttack = (await api('POST', '/attacks/matchmake', { token: instant.token, body: { requestId: 'instant-match' } })).json
  await api('POST', '/attacks/frames', { token: instant.token, body: { attackId: instantAttack.attackId, frames: validBattleFrames(instantAttack, 50, 2, 100) } })
  const instantEnd = (await api('POST', '/attacks/end', { token: instant.token, body: { attackId: instantAttack.attackId, destruction: 100, goldLooted: 999999 } })).json
  ok(instantEnd.lootApplied >= 0 && instantEnd.lootApplied < instantAttack.lootCap && instantEnd.trophyDelta <= 0,
    'an immediate forged 100% claim is bounded to the honest first-volley ceiling')

  const thrownVictim = (await api('POST', '/auth/session', { body: {} })).json
  const thrownRaider = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(thrownRaider.token, 1, 'arm-thrown-raid')
  const thrownAttack = await matchmakeUntil(thrownRaider.token, thrownVictim.player.id, 'thrown-raid')
  await api('POST', '/attacks/frames', {
    token: thrownRaider.token,
    body: { attackId: thrownAttack.attackId, frames: [{
      t: 10, destruction: 0, goldLooted: 0, buildings: [],
      troops: [{ id: 'thrown-root', type: 'warrior', level: 1, owner: 'PLAYER', gridX: 2, gridY: 2, health: 100, maxHealth: 100 }]
    }] }
  })
  const thrownEnd = (await api('POST', '/attacks/end', { token: thrownRaider.token, body: { attackId: thrownAttack.attackId, status: 'finished' } })).json
  const thrownVictimProfile = (await api('POST', '/auth/session', { body: { token: thrownVictim.token } })).json.player
  ok(thrownEnd.trophyDelta === 0 && thrownVictimProfile.trophies === 0,
    'a zero-trophy throwaway cannot mint trophies for the defender by losing')
  ok((thrownVictimProfile.shieldUntil ?? 0) <= Date.now(),
    'a fought but zero-destruction throwaway raid grants no renewable shield')

  // Target acquisition happens before first-command validation. A bad first
  // sequence must roll that tentative lease back atomically.
  const gapVictim = (await api('POST', '/auth/session', { body: {} })).json
  const gapRaider = (await api('POST', '/auth/session', { body: {} })).json
  const gapContender = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(gapRaider.token, 1, 'arm-gap-raider')
  await armWarriors(gapContender.token, 1, 'arm-gap-contender')
  const gapStart = await matchmakeUntil(gapRaider.token, gapVictim.player.id, 'gap-start')
  const contenderStart = await matchmakeUntil(gapContender.token, gapVictim.player.id, 'gap-contender')
  const deploymentCommand = (id, sequence) => ({
    type: 'DEPLOY', commandId: `command-${id}`, sequence,
    troopInstanceId: id, troopType: 'warrior', gridX: 2, gridY: 2
  })
  const sequenceGap = await api('POST', '/attacks/commands', {
    token: gapRaider.token,
    body: { attackId: gapStart.attackId, commands: [deploymentCommand('gap-root', 2)] }
  })
  ok(sequenceGap.status === 400, 'a first-command sequence gap is rejected')
  const contenderDeploy = await api('POST', '/attacks/commands', {
    token: gapContender.token,
    body: { attackId: contenderStart.attackId, commands: [deploymentCommand('contender-root', 1)] }
  })
  ok(contenderDeploy.status === 200,
    'a rejected first command rolls back its tentative defender lease')
  await api('POST', '/attacks/end', { token: gapContender.token, body: { attackId: contenderStart.attackId, status: 'aborted' } })
  await api('POST', '/attacks/end', { token: gapRaider.token, body: { attackId: gapStart.attackId, status: 'aborted' } })

  // Pre-deployment selections may coexist; only the first real root troop
  // acquires the defender. A sleeper cannot enter after that battle shields it.
  const raceVictim = (await api('POST', '/auth/session', { body: {} })).json
  const raceOne = (await api('POST', '/auth/session', { body: {} })).json
  const raceTwo = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(raceOne.token, 50, 'arm-race-one')
  await armWarriors(raceTwo.token, 1, 'arm-race-two')
  const raceStartOne = await matchmakeUntil(raceOne.token, raceVictim.player.id, 'race-one')
  const raceStartTwo = await matchmakeUntil(raceTwo.token, raceVictim.player.id, 'race-two')
  ok(raceStartOne.attackId && raceStartTwo.attackId,
    'multiple pre-deployment selections do not reserve a victim for ten minutes')
  const rootFrame = (attackId, id, t = 10) => ({
    t, destruction: 0, goldLooted: 0, buildings: [],
    troops: [{ id, type: 'warrior', level: 99, owner: 'PLAYER', gridX: 2, gridY: 2, health: 100, maxHealth: 100 }]
  })
  ok((await api('POST', '/attacks/frames', { token: raceOne.token, body: { attackId: raceStartOne.attackId, frames: validBattleFrames(raceStartOne, 50, 3, 100) } })).status === 200,
    'the first validated root deployment acquires the victim')
  await new Promise(resolve => setTimeout(resolve, 2500))
  await api('POST', '/attacks/end', { token: raceOne.token, body: { attackId: raceStartOne.attackId, status: 'finished' } })
  const sleeper = await api('POST', '/attacks/frames', { token: raceTwo.token, body: { attackId: raceStartTwo.attackId, frames: [rootFrame(raceStartTwo.attackId, 'race-root-two')] } })
  ok(sleeper.status === 403, 'a pending sleeper receives the precise shield rejection after another raid wins')
  ok((await api('POST', '/attacks/matchmake', { token: raceOne.token, body: { requestId: raceStartOne.requestId } })).status === 409,
    'a finished PvP start request is never replayed as a fresh live attack')

  const movingVictim = (await api('POST', '/auth/session', { body: {} })).json
  const movingRaider = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(movingRaider.token, 1, 'arm-moving-raider')
  const movingStart = await matchmakeUntil(movingRaider.token, movingVictim.player.id, 'moving-target')
  ok((await api('POST', '/map/relocate', { token: movingVictim.token, body: {} })).status === 200,
    'a victim may relocate while an attacker is only selecting deployment')
  ok((await api('POST', '/attacks/frames', { token: movingRaider.token, body: { attackId: movingStart.attackId, frames: [rootFrame(movingStart.attackId, 'moving-root')] } })).status === 409,
    'deployment rejects a stale snapshot after the victim relocates')

  // Destruction is a monotonic server ledger: the real client removes ruins
  // from later snapshots, so settlement must remember an earlier destroyed id.
  const ledgerRaider = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(ledgerRaider.token, 50, 'arm-destruction-ledger')
  const ledgerAttack = (await api('POST', '/attacks/matchmake', { token: ledgerRaider.token, body: { requestId: 'destruction-ledger' } })).json
  const ledgerTargets = ledgerAttack.world.buildings.filter(building => building.type !== 'wall')
  const ledgerTroops = Array.from({ length: 50 }, (_, i) => ({
    id: `ledger-w${i}`, type: 'warrior', level: 1, owner: 'PLAYER', gridX: 2 + i / 100, gridY: 2, health: 100, maxHealth: 100
  }))
  await api('POST', '/attacks/frames', { token: ledgerRaider.token, body: { attackId: ledgerAttack.attackId, frames: [
    { t: 10, destruction: 0, goldLooted: 0, buildings: [], troops: ledgerTroops },
    { t: 20, destruction: 100, goldLooted: 999999, buildings: [{ id: ledgerTargets[0].id, health: 0, isDestroyed: true }], troops: ledgerTroops },
    { t: 30, destruction: 0, goldLooted: 0, buildings: ledgerTargets.slice(1).map(building => ({ id: building.id, health: 1, isDestroyed: false })), troops: ledgerTroops }
  ] } })
  const ledgerEnd = (await api('POST', '/attacks/end', { token: ledgerRaider.token, body: { attackId: ledgerAttack.attackId, status: 'finished' } })).json
  const ledgerReplay = (await api('GET', `/replays/${ledgerAttack.attackId}`, { token: ledgerRaider.token })).json.replay
  ok(ledgerEnd.lootApplied > 0 && ledgerReplay.finalResult?.destruction > 0,
    'an earlier destroyed building remains credited when the final client frame omits it')
  ok(ledgerReplay.troopLevel === undefined && ledgerReplay.destroyedBuildingIds === undefined,
    'private combat authority fields are stripped from replay responses')

  // ---- Upgrade timers: the save charges, the TIMER earns the level ----
  // (CLASH_UPGRADE_DURATION_MS=300: every timed building takes exactly 300ms.)
  const clockUser = (await api('POST', '/auth/session', { body: {} })).json
  await api('POST', '/resources/apply', { token: clockUser.token, body: { delta: 30_000, reason: 'debug_grant', requestId: 'clock-gold' } })
  await api('POST', '/resources/apply', { token: clockUser.token, body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'clock-ore-seed' } })
  let clockWorld = (await api('GET', '/world', { token: clockUser.token })).json.world
  clockWorld.buildings.push({ id: 'clock-store', type: 'storage', gridX: 2, gridY: 2, level: 1 })
  clockWorld = (await api('POST', '/world/save', { token: clockUser.token, body: { world: clockWorld, requestId: 'clock-place' } })).json.world
  // Grant ore only once the storehouse raises the cap, or it clamps at base.
  await api('POST', '/resources/apply', { token: clockUser.token, body: { delta: 2_000, resource: 'ore', reason: 'debug_grant', requestId: 'clock-ore' } })
  clockWorld = (await api('GET', '/world', { token: clockUser.token })).json.world
  const clockGoldBefore = clockWorld.resources.gold
  clockWorld.buildings.find(b => b.id === 'clock-store').level = 2
  const clockUpgradeRequestedAt = Date.now()
  const clockPendingWorld = (await api('POST', '/world/save', { token: clockUser.token, body: { world: clockWorld, requestId: 'clock-up-2' } })).json.world
  const clockUpgradeRespondedAt = Date.now()
  const clockPendingStore = clockPendingWorld.buildings.find(b => b.id === 'clock-store')
  ok(clockPendingStore.level === 1 && clockPendingStore.upgradingTo === 2
    && clockPendingStore.upgradeStartedAt > 0
    && clockPendingStore.upgradeEndsAt > 0 && clockPendingWorld.resources.gold < clockGoldBefore,
    'an upgrade save charges immediately but holds the level behind a visible clock')
  const fixedClockStartedAt = clockPendingStore.upgradeStartedAt
  ok(clockPendingStore.upgradeEndsAt === fixedClockStartedAt + 300,
    'the legacy backend persists one exact server-authored upgrade interval')
  ok(fixedClockStartedAt >= clockUpgradeRequestedAt && fixedClockStartedAt <= clockUpgradeRespondedAt,
    'the legacy backend assigns the configured fixed upgrade duration exactly')
  // An echo save (client mirroring the pending world back) is a read: the
  // clock survives and nothing is re-charged.
  const clockEcho = (await api('POST', '/world/save', { token: clockUser.token, body: { world: clockPendingWorld, requestId: 'clock-echo' } })).json.world
  const clockEchoStore = clockEcho.buildings.find(b => b.id === 'clock-store')
  ok(clockEchoStore.upgradingTo === 2
    && clockEchoStore.upgradeStartedAt === fixedClockStartedAt
    && clockEchoStore.upgradeEndsAt === clockPendingStore.upgradeEndsAt
    && clockEcho.resources.gold === clockPendingWorld.resources.gold,
    'echoing the pending world back neither clears the clock nor re-charges')
  await new Promise(resolve => setTimeout(resolve, 400))
  clockWorld = (await api('GET', '/world', { token: clockUser.token })).json.world
  const clockLanded = clockWorld.buildings.find(b => b.id === 'clock-store')
  ok(clockLanded.level === 2
    && clockLanded.upgradingTo === undefined
    && clockLanded.upgradeStartedAt === undefined
    && clockLanded.upgradeEndsAt === undefined,
    'the new level lands only when the clock matures')
  await api('POST', '/resources/apply', { token: clockUser.token, body: { delta: 500, resource: 'ore', reason: 'debug_grant', requestId: 'clock-ore-2' } })
  clockWorld = (await api('GET', '/world', { token: clockUser.token })).json.world
  clockWorld.buildings.find(b => b.id === 'clock-store').level = 3
  clockWorld = (await api('POST', '/world/save', { token: clockUser.token, body: { world: clockWorld, requestId: 'clock-up-3' } })).json.world
  const clockRetryWorld = JSON.parse(JSON.stringify(clockWorld))
  clockRetryWorld.buildings.find(b => b.id === 'clock-store').level = 3
  const clockDouble = await api('POST', '/world/save', { token: clockUser.token, body: { world: clockRetryWorld, requestId: 'clock-up-3b' } })
  ok(clockDouble.status === 409 && clockDouble.json?.code === 'UPGRADE_IN_PROGRESS',
    'a second upgrade on a working site is refused while the clock runs')
  await new Promise(resolve => setTimeout(resolve, 600))
  const clockDone = (await api('GET', '/world', { token: clockUser.token })).json.world
  ok(clockDone.buildings.find(b => b.id === 'clock-store').level === 3,
    'the second work also lands on schedule')
  // Multi-level jumps: use the cannon (13 levels, so the sanitizer's
  // max-level clamp cannot fold the jump back into a single step).
  const clockLeapWorld = JSON.parse(JSON.stringify(clockDone))
  const clockCannon = clockLeapWorld.buildings.find(b => b.type === 'cannon')
  clockCannon.level = (clockCannon.level ?? 1) + 2
  const clockLeap = await api('POST', '/world/save', { token: clockUser.token, body: { world: clockLeapWorld, requestId: 'clock-leap' } })
  ok(clockLeap.status === 400, 'multi-level jumps are refused: one step per work')

  // A level-3 lab plus a chain-credit Storm Mage squad must fit inside the
  // honest ceiling even though the client-reported troop level is untrusted.
  const mechanics = (await api('POST', '/auth/session', { body: {} })).json
  await api('POST', '/resources/apply', { token: mechanics.token, body: { delta: 30_000, reason: 'debug_grant', requestId: 'mechanics-gold' } })
  await api('POST', '/resources/apply', { token: mechanics.token, body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'mechanics-ore-1' } })
  let mechanicsWorld = (await api('GET', '/world', { token: mechanics.token })).json.world
  mechanicsWorld.buildings.push({ id: 'mechanics-store', type: 'storage', gridX: 2, gridY: 2, level: 1 })
  mechanicsWorld = (await api('POST', '/world/save', { token: mechanics.token, body: { world: mechanicsWorld, requestId: 'mechanics-store-1' } })).json.world
  // Upgrades run one level per save behind the (scaled-down) work clock, so
  // step each level and let it mature before the next.
  const stepUpgrade = async (token, match, targetLevel, keyPrefix) => {
    for (;;) {
      const world = (await api('GET', '/world', { token })).json.world
      const target = world.buildings.find(match)
      if ((target.level ?? 1) >= targetLevel) return
      target.level = (target.level ?? 1) + 1
      await api('POST', '/world/save', { token, body: { world, requestId: `${keyPrefix}-${target.level}` } })
      await new Promise(resolve => setTimeout(resolve, 700))
    }
  }
  await api('POST', '/resources/apply', { token: mechanics.token, body: { delta: 400, resource: 'ore', reason: 'debug_grant', requestId: 'mechanics-ore-2' } })
  await stepUpgrade(mechanics.token, building => building.id === 'mechanics-store', 2, 'mechanics-store-up2')
  await api('POST', '/resources/apply', { token: mechanics.token, body: { delta: 700, resource: 'ore', reason: 'debug_grant', requestId: 'mechanics-ore-3' } })
  await stepUpgrade(mechanics.token, building => building.id === 'mechanics-store', 3, 'mechanics-store-up3')
  await api('POST', '/resources/apply', { token: mechanics.token, body: { delta: 1_000, resource: 'ore', reason: 'debug_grant', requestId: 'mechanics-ore-4' } })
  mechanicsWorld = (await api('GET', '/world', { token: mechanics.token })).json.world
  mechanicsWorld.buildings.push({ id: 'mechanics-mystic-barracks', type: 'mystic_barracks', gridX: 18, gridY: 3, level: 1 })
  mechanicsWorld = (await api('POST', '/world/save', { token: mechanics.token, body: { world: mechanicsWorld, requestId: 'mechanics-mystic-barracks-place' } })).json.world
  await stepUpgrade(mechanics.token, building => building.id === 'mechanics-mystic-barracks', 3, 'mechanics-mystic-barracks-up')
  mechanicsWorld = (await api('GET', '/world', { token: mechanics.token })).json.world
  mechanicsWorld.buildings.push({ id: 'mechanics-lab', type: 'lab', gridX: 5, gridY: 2, level: 3 })
  const mechanicsSaved = await api('POST', '/world/save', { token: mechanics.token, body: { world: mechanicsWorld, requestId: 'mechanics-lab-save' } })
  ok(mechanicsSaved.status === 200, 'a researched army setup is persisted for combat authority')
  const stormmageTrain = await api('POST', '/army/train', { token: mechanics.token, body: { type: 'stormmage', count: 3, requestId: 'mechanics-stormmage-train' } })
  ok(stormmageTrain.status === 200, 'three researched Storm Mages train at the level-3 Mystic Barracks')
  const mechanicsAttack = (await api('POST', '/attacks/matchmake', { token: mechanics.token, body: { requestId: 'mechanics-attack' } })).json
  const mechanicsTarget = mechanicsAttack.world.buildings.find(building => building.type !== 'wall')
  const stormmageSquad = Array.from({ length: 3 }, (_, i) => ({
    id: `mechanics-r${i}`, type: 'stormmage', level: 99, owner: 'PLAYER', gridX: 2 + i / 10, gridY: 2,
    health: 330, maxHealth: 330
  }))
  await api('POST', '/attacks/frames', { token: mechanics.token, body: { attackId: mechanicsAttack.attackId, frames: [{
    t: 10, destruction: 100, goldLooted: 999999,
    buildings: [{ id: mechanicsTarget.id, health: 0, isDestroyed: true }], troops: stormmageSquad
  }] } })
  const mechanicsEnd = (await api('POST', '/attacks/end', { token: mechanics.token, body: { attackId: mechanicsAttack.attackId, status: 'finished' } })).json
  const mechanicsReplay = (await api('GET', `/replays/${mechanicsAttack.attackId}`, { token: mechanics.token })).json.replay
  ok(mechanicsEnd.lootApplied > 0 && mechanicsReplay.frames[0].troops.every(troop => troop.level === 3),
    'lab scaling is credited from the private level-3 snapshot')

  // 2. Frames must stream forward in time.
  const flow = (await api('POST', '/attacks/matchmake', { token: rotB.token, body: { requestId: 'flow-match' } })).json
  const c1 = (await api('POST', '/attacks/frames', { token: rotB.token, body: { attackId: flow.attackId, frames: [{ t: 1, destruction: 0, goldLooted: 0, buildings: [], troops: [] }] } })).json
  const c2 = (await api('POST', '/attacks/frames', { token: rotB.token, body: { attackId: flow.attackId, frames: [{ t: 0, destruction: 0, goldLooted: 0, buildings: [], troops: [] }] } })).json
  ok(c1.frameCount === 1 && c2.frameCount === 1, 'out-of-order frames are dropped (the stream flows forward)')
  const futureFrame = (await api('POST', '/attacks/frames', { token: rotB.token, body: { attackId: flow.attackId, frames: [{ t: 999999, destruction: 100, goldLooted: 99999, buildings: [], troops: [] }] } })).json
  ok(futureFrame.frameCount === 1, 'replay frames claiming future combat time are rejected')

  let cappedFrameCount = c2.frameCount
  for (let batch = 0; batch < 4; batch++) {
    const many = Array.from({ length: 240 }, (_, i) => ({ t: 2 + batch * 240 + i, destruction: 0, goldLooted: 0, buildings: [], troops: [] }))
    cappedFrameCount = (await api('POST', '/attacks/frames', { token: rotB.token, body: { attackId: flow.attackId, frames: many } })).json.frameCount
  }
  ok(cappedFrameCount === 900, 'a replay is hard-capped at 900 frames')
  const oversizedBody = await api('POST', '/attacks/frames', { token: rotB.token, body: { attackId: flow.attackId, padding: 'x'.repeat(2 * 1024 * 1024), frames: [] } })
  ok(oversizedBody.status === 400, 'oversized replay request bodies are rejected before JSON processing')

  // 3. Incremental spectate polls omit the (already-known) enemy world.
  const full = (await api('GET', `/replays/${flow.attackId}`, { token: rotB.token })).json.replay
  const slim = (await api('GET', `/replays/${flow.attackId}?afterT=0`, { token: rotB.token })).json.replay
  ok(full.frames.at(-1)?.t === 961, 'frame-cap thinning preserves the newest valid battle state')
  ok(Boolean(full.enemyWorld) && slim.enemyWorld === undefined, 'afterT polls are slim: no enemy world re-shipped')
  await api('POST', '/attacks/end', { token: rotB.token, body: { attackId: flow.attackId, destruction: 0, goldLooted: 0, status: 'aborted' } })

  // Large normal frames also roll forward at the byte cap instead of freezing
  // settlement at whichever mid-battle frame happened to fill two megabytes.
  const byteCapVictim = (await api('POST', '/auth/session', { body: {} })).json
  const byteCapRaider = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(byteCapRaider.token, 50, 'arm-byte-cap')
  const byteCapAttack = await matchmakeUntil(byteCapRaider.token, byteCapVictim.player.id, 'byte-cap-match')
  const byteCapTarget = byteCapAttack.world.buildings.find(building => building.type !== 'wall')
  const byteCapRoots = Array.from({ length: 50 }, (_, i) => ({
    id: `byte-root-${i}`, type: 'warrior', level: 1, owner: 'PLAYER', gridX: 2 + i / 100, gridY: 2, health: 100, maxHealth: 100
  }))
  const byteCapNoise = Array.from({ length: 550 }, (_, i) => ({
    id: `byte-enemy-${i}`, type: 'warrior', level: 1, owner: 'ENEMY', gridX: 20 + i / 100, gridY: 20, health: 100, maxHealth: 100
  }))
  for (let batch = 0; batch < 4; batch++) {
    const frames = Array.from({ length: 10 }, (_, i) => {
      const t = batch * 10 + i + 1
      const terminal = t === 40
      return {
        t,
        destruction: terminal ? 100 : 0,
        goldLooted: terminal ? 999999 : 0,
        buildings: terminal ? [{ id: byteCapTarget.id, health: 0, isDestroyed: true }] : [],
        troops: [...byteCapRoots, ...byteCapNoise]
      }
    })
    const pushedBytes = await api('POST', '/attacks/frames', { token: byteCapRaider.token, body: { attackId: byteCapAttack.attackId, frames } })
    ok(pushedBytes.status === 200, `byte-capped frame batch ${batch + 1} remains writable`)
  }
  const byteCapReplay = (await api('GET', `/replays/${byteCapAttack.attackId}`, { token: byteCapRaider.token })).json.replay
  ok(byteCapReplay.frames.length < 40 && byteCapReplay.frames.at(-1)?.t === 40,
    'byte-cap thinning evicts intermediates and keeps the terminal frame')
  const byteCapEnd = (await api('POST', '/attacks/end', { token: byteCapRaider.token, body: { attackId: byteCapAttack.attackId, status: 'finished' } })).json
  ok(byteCapEnd.lootApplied > 0, 'settlement credits destruction observed in the newest byte-capped frame')

  // Live spectators may see the battle geometry, but not either participant's
  // private loot caps. Create adjacent accounts so a level-1 watchtower grants
  // legitimate spectate authorization.
  let spectator
  let spectatorVictim
  for (let attempt = 0; attempt < 3; attempt++) {
    const viewer = (await api('POST', '/auth/session', { body: {} })).json
    const victim = (await api('POST', '/auth/session', { body: {} })).json
    const distance = Math.max(Math.abs(viewer.player.plotX - victim.player.plotX), Math.abs(viewer.player.plotY - victim.player.plotY))
    if (distance <= 1) {
      spectator = viewer
      spectatorVictim = victim
      break
    }
  }
  ok(Boolean(spectator && spectatorVictim), 'an adjacent account pair is available for live spectating')
  if (spectator && spectatorVictim) {
    await api('POST', '/resources/apply', { token: spectator.token, body: { delta: 50, resource: 'ore', reason: 'debug_grant', requestId: 'spectator-ore' } })
    const spectatorWorld = (await api('GET', '/world', { token: spectator.token })).json.world
    spectatorWorld.buildings.push({ id: 'spectator-watch', type: 'watchtower', gridX: 2, gridY: 18, level: 1 })
    await api('POST', '/world/save', { token: spectator.token, body: { world: spectatorWorld, requestId: 'spectator-watch-save' } })
    const spectatorRaider = (await api('POST', '/auth/session', { body: {} })).json
    await armWarriors(spectatorRaider.token, 1, 'arm-spectator-raid')
    const spectatorAttack = await matchmakeUntil(spectatorRaider.token, spectatorVictim.player.id, 'spectator-match')
    await api('POST', '/attacks/frames', {
      token: spectatorRaider.token,
      body: { attackId: spectatorAttack.attackId, frames: [{
        t: 10, destruction: 0, goldLooted: 0, buildings: [],
        troops: [{ id: 'spectator-root', type: 'warrior', level: 1, owner: 'PLAYER', gridX: 2, gridY: 2, health: 100, maxHealth: 100 }]
      }] }
    })
    const spectatorReplayResponse = await api('GET', `/replays/${spectatorAttack.attackId}`, { token: spectator.token })
    const spectatorReplay = spectatorReplayResponse.json.replay
    ok(spectatorReplayResponse.status === 200 && !Object.hasOwn(spectatorReplay, 'lootCap')
      && !Object.hasOwn(spectatorReplay, 'lootCapOre') && !Object.hasOwn(spectatorReplay, 'lootCapFood')
      && spectatorReplay.enemyWorld.resources.gold === 0 && spectatorReplay.enemyWorld.resources.ore === 0
      && spectatorReplay.enemyWorld.resources.food === 0,
    'live spectator replays redact defender loot caps and resource projections')
    await api('POST', '/attacks/end', { token: spectatorRaider.token, body: { attackId: spectatorAttack.attackId, status: 'aborted' } })
  }

  // 4. Shop limits bind server-side.
  const greedy = { ...rotA.world, buildings: [
    ...rotA.world.buildings,
    { id: 'th2', type: 'town_hall', gridX: 2, gridY: 2, level: 1 },
    { id: 'th3', type: 'town_hall', gridX: 6, gridY: 2, level: 1 }
  ] }
  const capped = (await api('POST', '/world/save', { token: rotA.token, body: { world: greedy, requestId: 'rot-cap-1' } })).json
  ok(capped.world.buildings.filter(b => b.type === 'town_hall').length === 1, 'per-type shop limits bind on the server (one town hall)')

  const duplicateIdWorld = {
    ...capped.world,
    buildings: [...capped.world.buildings, { ...capped.world.buildings[0], type: 'cannon', gridX: 0, gridY: 0 }]
  }
  ok((await api('POST', '/world/save', { token: rotA.token, body: { world: duplicateIdWorld, requestId: 'duplicate-building-id' } })).status === 400,
    'duplicate building ids cannot bypass per-type limits by replacing Map entries')
  const inheritedBuildingWorld = {
    ...capped.world,
    buildings: [...capped.world.buildings, { id: 'prototype-building', type: 'constructor', gridX: 0, gridY: 0, level: 99 }]
  }
  const inheritedBuildingSave = await api('POST', '/world/save', { token: rotA.token, body: { world: inheritedBuildingWorld, requestId: 'prototype-building-save' } })
  ok(inheritedBuildingSave.status === 200 && !inheritedBuildingSave.json.world.buildings.some(building => building.id === 'prototype-building'),
    'inherited object keys are never accepted as building definitions')

  const prototypeRaider = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(prototypeRaider.token, 1, 'arm-prototype-raider')
  const prototypeAttack = (await api('POST', '/attacks/matchmake', { token: prototypeRaider.token, body: { requestId: 'prototype-troop-attack' } })).json
  const prototypeTarget = prototypeAttack.world.buildings.find(building => building.type !== 'wall')
  await api('POST', '/attacks/frames', { token: prototypeRaider.token, body: { attackId: prototypeAttack.attackId, frames: [{
    t: 10, destruction: 100, goldLooted: 999999,
    buildings: [{ id: prototypeTarget.id, health: 0, isDestroyed: true }],
    troops: [{ id: '__proto__', type: 'constructor', level: 99, owner: 'PLAYER', gridX: 1, gridY: 1, health: 999999, maxHealth: 999999 }]
  }] } })
  const prototypeEnd = (await api('POST', '/attacks/end', { token: prototypeRaider.token, body: { attackId: prototypeAttack.attackId, status: 'finished' } })).json
  ok(prototypeEnd.lootApplied === 0 && prototypeEnd.trophyDelta === 0,
    'prototype-key troop ids/types cannot create a deployment or non-finite loot budget')

  const overCap = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(overCap.token, 31, 'arm-over-cap-layout')
  const overCapWorld = (await api('GET', '/world', { token: overCap.token })).json.world
  overCapWorld.buildings = overCapWorld.buildings.filter(building => building.type !== 'army_camp')
  const overCapSave = await api('POST', '/world/save', { token: overCap.token, body: { world: overCapWorld, requestId: 'remove-needed-camp' } })
  ok(overCapSave.status === 409 && overCapSave.json.code === 'ARMY_OVER_CAPACITY',
    'a camp cannot be removed while its trained army space is occupied')

  const obstacleOwner = (await api('POST', '/auth/session', { body: {} })).json
  let obstacleWorld = (await api('GET', '/world', { token: obstacleOwner.token })).json.world
  obstacleWorld.obstacles.push({ id: 'grown-grass', type: 'grass_patch', gridX: 0, gridY: 0 })
  obstacleWorld = (await api('POST', '/world/save', { token: obstacleOwner.token, body: { world: obstacleWorld, requestId: 'grow-grass' } })).json.world
  obstacleWorld.obstacles.find(obstacle => obstacle.id === 'grown-grass').gridX = 1
  ok((await api('POST', '/world/save', { token: obstacleOwner.token, body: { world: obstacleWorld, requestId: 'move-grass-forge' } })).status === 400,
    'persisted obstacles cannot be moved or transmuted before clearing')
  obstacleWorld = (await api('GET', '/world', { token: obstacleOwner.token })).json.world
  const obstacleGoldBefore = obstacleWorld.resources.gold
  obstacleWorld.obstacles = obstacleWorld.obstacles.filter(obstacle => obstacle.id !== 'grown-grass')
  const clearedGrass = (await api('POST', '/world/save', {
    token: obstacleOwner.token,
    body: { world: obstacleWorld, requestId: 'ambient-clear-grass' }
  })).json.world
  ok(clearedGrass.resources.gold >= obstacleGoldBefore + 5,
    'ambient obstacle removal is reward-only and never levies a hidden clear fee')

  // 5. Guest deletion must also release every active battle lock.
  const dropVictim = (await api('POST', '/auth/session', { body: {} })).json
  const dropper = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(dropper.token, 1, 'arm-dropper')
  const droppedAttack = await matchmakeUntil(dropper.token, dropVictim.player.id, 'dropper-match')
  await api('POST', '/attacks/frames', { token: dropper.token, body: { attackId: droppedAttack.attackId, frames: [rootFrame(droppedAttack.attackId, 'dropper-root')] } })
  await api('POST', '/auth/logout', { token: dropper.token })
  const afterDropIncoming = (await api('GET', '/attacks/incoming', { token: dropVictim.token })).json
  ok(!afterDropIncoming.sessions?.some(session => session.attackId === droppedAttack.attackId),
    'deleting an attacking guest aborts and untracks its victim lock')

  // 6. A guest logging out of their only session releases the plot (no eternal ghost).
  const ghost = (await api('POST', '/auth/session', { body: {} })).json
  const ghostPlot = { x: ghost.player.plotX, y: ghost.player.plotY }
  await api('POST', '/auth/logout', { token: ghost.token })
  ok((await api('GET', '/world', { token: ghost.token })).status === 401, 'guest logout revokes the session')
  const ghostAtlas = (await api('GET', '/map/atlas', { token: rotA.token })).json
  ok(!ghostAtlas.players.some(player => player.x === ghostPlot.x && player.y === ghostPlot.y), "the ghost's plot returns to the wilderness")

  // 7. The orphaned reset endpoint is gone.
  ok((await api('POST', '/world/reset', { token: rotA.token })).status === 404, 'the caller-less /world/reset endpoint was removed')

  // --- Economy transactions: the save IS the purchase ---
  console.log('\nEconomy transactions:')
  const eco = (await api('POST', '/auth/session')).json
  const ecoGold = () => api('GET', '/world', { token: eco.token }).then(r => r.json.world.resources)

  const forgedWall = {
    ...eco.world,
    wallLevel: 4,
    buildings: [...eco.world.buildings, { id: 'forged_wall_l4', type: 'wall', gridX: 0, gridY: 0, level: 4 }]
  }
  const wallRefusal = await api('POST', '/world/save', { token: eco.token, body: { world: forgedWall, requestId: 'wall-ladder-forge' } })
  ok(wallRefusal.status === 409 && wallRefusal.json.code === 'INSUFFICIENT_RESOURCES' && wallRefusal.json.resource === 'gold',
    'an unaffordable L4 wall returns a structured resource error after full ladder pricing')
  const mixedWalls = {
    ...eco.world,
    wallLevel: 2,
    buildings: [
      ...eco.world.buildings,
      { id: 'mixed_wall_1', type: 'wall', gridX: 0, gridY: 0, level: 1 },
      { id: 'mixed_wall_2', type: 'wall', gridX: 1, gridY: 0, level: 2 }
    ]
  }
  const mixedRefusal = await api('POST', '/world/save', { token: eco.token, body: { world: mixedWalls, requestId: 'wall-mixed-forge' } })
  ok(mixedRefusal.status === 400, 'mixed wall cohort levels are rejected')

  // The free-levels exploit is dead: a forged high-level save is priced and refused.
  const ecoForged = {
    ...eco.world,
    buildings: [...eco.world.buildings, { id: 'forged_mine', type: 'mine', gridX: 2, gridY: 18, level: 3 }]
  }
  const refusal = await api('POST', '/world/save', { token: eco.token, body: { world: ecoForged, requestId: 'eco-forge-1' } })
  ok(refusal.status === 409, `a forged max-level save is refused, not granted (${refusal.status})`)
  const afterRefusal = await ecoGold()
  ok(afterRefusal.gold === 1000 && !((await api('GET', '/world', { token: eco.token })).json.world.buildings.some(bl => bl.id === 'forged_mine')),
    'a refused save changes nothing (balance intact, building absent)')

  // Fund and buy honestly: a level-1 mine costs 350 gold + 35 ore.
  await api('POST', '/resources/apply', { token: eco.token, body: { delta: 9000, reason: 'debug_grant', requestId: 'eco-fund-g' } })
  await api('POST', '/resources/apply', { token: eco.token, body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'eco-fund-o' } })
  const beforeBuy = await ecoGold()
  const fundedEcoWorld = (await api('GET', '/world', { token: eco.token })).json.world
  const buyWorld = { ...fundedEcoWorld, buildings: [...fundedEcoWorld.buildings, { id: 'eco_mine', type: 'mine', gridX: 2, gridY: 18, level: 1 }] }
  const bought = (await api('POST', '/world/save', { token: eco.token, body: { world: buyWorld, requestId: 'eco-buy-1' } })).json
  ok(bought.world.resources.gold === beforeBuy.gold - 350 && bought.world.resources.ore === beforeBuy.ore - 35,
    `placing a mine charges 350 gold + 35 ore (${beforeBuy.gold}->${bought.world.resources.gold}, ${beforeBuy.ore}->${bought.world.resources.ore})`)

  // The upgrade ore sink can exceed the base ore cap — a storehouse gates it.
  const storeWorld = { ...bought.world, buildings: [...bought.world.buildings, { id: 'eco_store', type: 'storage', gridX: 6, gridY: 18, level: 1 }] }
  const stored = (await api('POST', '/world/save', { token: eco.token, body: { world: storeWorld, requestId: 'eco-store-1' } })).json
  ok(stored.world.resources.gold === bought.world.resources.gold - 400, 'the storehouse purchase charges through the same save')
  await api('POST', '/resources/apply', { token: eco.token, body: { delta: 400, resource: 'ore', reason: 'debug_grant', requestId: 'eco-fund-o2' } })

  // Upgrading the mine 1 -> 2 charges 900 gold + 180 ore in one save diff.
  const preUp = (await api('GET', '/world', { token: eco.token })).json.world
  const upWorld = { ...preUp, buildings: preUp.buildings.map(bl => bl.id === 'eco_mine' ? { ...bl, level: 2 } : bl) }
  const upgraded = (await api('POST', '/world/save', { token: eco.token, body: { world: upWorld, requestId: 'eco-up-1' } })).json
  ok(upgraded.world.resources.gold === preUp.resources.gold - 900 && upgraded.world.resources.ore === preUp.resources.ore - 180,
    `a level upgrade charges gold + the 20% ore sink (${preUp.resources.gold}->${upgraded.world.resources.gold}, ${preUp.resources.ore}->${upgraded.world.resources.ore})`)

  // Demolition refunds 80% of the current level's price (mine L2 = 900 -> 720 back).
  // Let the upgrade clock land level 2 first — a pending work refunds at the old level.
  await new Promise(resolve => setTimeout(resolve, 500))
  const upgradedSettled = (await api('GET', '/world', { token: eco.token })).json
  upgraded.world.resources = upgradedSettled.world.resources
  const delWorld = { ...upgradedSettled.world, buildings: upgradedSettled.world.buildings.filter(bl => bl.id !== 'eco_mine') }
  const deleted = (await api('POST', '/world/save', { token: eco.token, body: { world: delWorld, requestId: 'eco-del-1' } })).json
  ok(deleted.world.resources.gold === upgraded.world.resources.gold + 720,
    `demolition refunds 80% of the level price (${upgraded.world.resources.gold}->${deleted.world.resources.gold})`)

  // The free-army exploit is dead: armies in world saves are ignored entirely.
  const armyForge = { ...deleted.world, army: { golem: 500, warrior: 100 } }
  await api('POST', '/world/save', { token: eco.token, body: { world: armyForge, requestId: 'eco-army-forge' } })
  const armyAfterForge = (await api('GET', '/world', { token: eco.token })).json.world.army
  ok(Object.keys(armyAfterForge).length === 0, 'a forged army in a world save is ignored (server army untouched)')

  // Training is a server transaction: charges gold + food. The L1 Army Camp
  // unlocks the Barbarian; specialist troops enforce their matching barracks.
  const beforeTrain = await ecoGold()
  const trained = (await api('POST', '/army/train', { token: eco.token, body: { type: 'warrior', count: 2, requestId: 'eco-train-1' } })).json
  ok(trained.army.warrior === 2 && trained.gold === beforeTrain.gold - 50 && trained.food === beforeTrain.food - 4,
    `training 2 warriors charges 50 gold + 4 food (army=${trained.army.warrior})`)
  const ecoRetired = await api('POST', '/army/train', { token: eco.token, body: { type: 'needleback', count: 1 } })
  ok(ecoRetired.status === 404, `a removed troop cannot be newly trained (${ecoRetired.status})`)
  const untrained = (await api('POST', '/army/untrain', { token: eco.token, body: { type: 'warrior', count: 1, requestId: 'eco-untrain-1' } })).json
  ok(untrained.army.warrior === 1 && untrained.gold === trained.gold + 25 && untrained.food === trained.food + 2,
    'untraining refunds the full bill')

  // ARMY CAMP CORE — remove both faction barracks from a fresh village. The
  // L1-L4 Camp curve unlocks exactly one foundational troop per completed
  // level, while a faction starter remains locked.
  const core = (await api('POST', '/auth/session')).json
  await api('POST', '/resources/apply', { token: core.token, body: { delta: 1000, reason: 'debug_grant', requestId: 'core-gold' } })
  await api('POST', '/resources/apply', { token: core.token, body: { delta: 100, resource: 'food', reason: 'debug_grant', requestId: 'core-food' } })
  const coreWorld = (await api('GET', '/world', { token: core.token })).json.world
  const factionBarracksTypes = new Set(['barracks', 'mystic_barracks'])
  coreWorld.buildings = coreWorld.buildings.filter(building => !factionBarracksTypes.has(building.type))
  const coreSaved = await api('POST', '/world/save', {
    token: core.token,
    body: { world: coreWorld, requestId: 'core-remove-all-barracks' }
  })
  ok(coreSaved.status === 200 && !coreSaved.json.world.buildings.some(building => factionBarracksTypes.has(building.type)),
    'a test village has every faction barracks removed')
  const campProgression = [
    { type: 'warrior', level: 1 },
    { type: 'archer', level: 2 },
    { type: 'physicianscart', level: 3 },
    { type: 'phalanx', level: 4 }
  ]
  const l1Core = await api('POST', '/army/train', {
    token: core.token,
    body: { type: 'warrior', count: 1, requestId: 'core-warrior-train' }
  })
  ok(l1Core.status === 200 && l1Core.json.army?.warrior === 1,
    `the Barbarian trains at Army Camp level 1 (${l1Core.status})`)
  for (const { type, level } of campProgression.slice(1)) {
    const early = await api('POST', '/army/train', {
      token: core.token,
      body: { type, count: 1, requestId: `core-${type}-too-early` }
    })
    ok(early.status === 403,
      `${type} stays locked below Army Camp level ${level} (${early.status})`)
  }
  await api('POST', '/resources/apply', { token: core.token, body: { delta: 5000, reason: 'debug_grant', requestId: 'core-camp-upgrade-gold' } })
  await api('POST', '/resources/apply', { token: core.token, body: { delta: 2000, resource: 'ore', reason: 'debug_grant', requestId: 'core-camp-upgrade-ore' } })
  for (const { type, level } of campProgression.slice(1)) {
    const beforeCampUpgrade = (await api('GET', '/world', { token: core.token })).json.world
    const camp = beforeCampUpgrade.buildings.find(building => building.type === 'army_camp')
    beforeCampUpgrade.buildings = beforeCampUpgrade.buildings.map(building => building.id === camp.id
      ? { ...building, level }
      : building)
    const campUpgrade = await api('POST', '/world/save', {
      token: core.token,
      body: { world: beforeCampUpgrade, requestId: `core-camp-level-${level}` }
    })
    ok(campUpgrade.status === 200,
      `the Army Camp level-${level} upgrade starts (${campUpgrade.status})`)
    await new Promise(resolve => setTimeout(resolve, 350))
    const completedCampWorld = (await api('GET', '/world', { token: core.token })).json.world
    ok(completedCampWorld.buildings.some(building => building.type === 'army_camp' && building.level === level && !building.upgradingTo),
      `the Army Camp level-${level} upgrade completes before its troop unlocks`)
    const coreTrain = await api('POST', '/army/train', {
      token: core.token,
      body: { type, count: 1, requestId: `core-${type}-train` }
    })
    ok(coreTrain.status === 200 && coreTrain.json.army?.[type] === 1,
      `${type} trains at Army Camp level ${level} (${coreTrain.status})`)
  }
  const coreFactionLocked = await api('POST', '/army/train', {
    token: core.token,
    body: { type: 'goblinplunderer', count: 1, requestId: 'core-faction-still-locked' }
  })
  ok(coreFactionLocked.status === 403,
    `a faction troop remains locked when all faction barracks are absent (${coreFactionLocked.status})`)

  // TWO-PATH TROOP ACCEPTANCE — a high barracks in the wrong faction never
  // unlocks a troop. The exact matching faction barracks does, one node per
  // level through the level-7 flagship. Each accepted troop also deploys
  // through the authoritative command machine via an isolated bot raid.
  const troopAcceptance = [
    { type: 'goblinplunderer', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 1 },
    { type: 'wallbreaker', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 2 },
    { type: 'stormmage', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 3 },
    { type: 'necromancer', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 4 },
    { type: 'warelephant', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 5 },
    { type: 'golem', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 6 },
    { type: 'icegolem', faction: 'mystic', barracksType: 'mystic_barracks', unlock: 7 },
    { type: 'clockworkbeetle', faction: 'mechanica', barracksType: 'barracks', unlock: 1 },
    { type: 'ram', faction: 'mechanica', barracksType: 'barracks', unlock: 2 },
    { type: 'mobilemortar', faction: 'mechanica', barracksType: 'barracks', unlock: 3 },
    { type: 'siegetower', faction: 'mechanica', barracksType: 'barracks', unlock: 4 },
    { type: 'trebuchet', faction: 'mechanica', barracksType: 'barracks', unlock: 5 },
    { type: 'ornithopter', faction: 'mechanica', barracksType: 'barracks', unlock: 6 },
    { type: 'davincitank', faction: 'mechanica', barracksType: 'barracks', unlock: 7 }
  ]
  for (const { type, faction, barracksType, unlock } of troopAcceptance) {
    const tag = `nta-${type}`
    const session = (await api('POST', '/auth/session')).json
    const initiallyLockedWorld = (await api('GET', '/world', { token: session.token })).json.world
    if (initiallyLockedWorld.buildings.some(building => building.type === barracksType)) {
      initiallyLockedWorld.buildings = initiallyLockedWorld.buildings.filter(building => building.type !== barracksType)
      const withoutMatchingBarracks = await api('POST', '/world/save', {
        token: session.token,
        body: { world: initiallyLockedWorld, requestId: `${tag}-remove-matching-barracks` }
      })
      ok(withoutMatchingBarracks.status === 200,
        `the ${type} authority check starts without a matching ${faction} barracks`)
    }
    const lockedTrain = await api('POST', '/army/train', { token: session.token, body: { type, count: 1, requestId: `${tag}-locked` } })
    ok(lockedTrain.status === 403, `${type} stays locked without its level-${unlock} ${faction} barracks (${lockedTrain.status})`)
    await api('POST', '/resources/apply', { token: session.token, body: { delta: 40000, reason: 'debug_grant', requestId: `${tag}-gold` } })
    await api('POST', '/resources/apply', { token: session.token, body: { delta: 5000, resource: 'ore', reason: 'debug_grant', requestId: `${tag}-ore` } })
    await api('POST', '/resources/apply', { token: session.token, body: { delta: 2000, resource: 'food', reason: 'debug_grant', requestId: `${tag}-food` } })
    const troopWorld = (await api('GET', '/world', { token: session.token })).json.world
    const matchingBarracks = troopWorld.buildings.find(bl => bl.type === barracksType)
    if (matchingBarracks) {
      troopWorld.buildings = troopWorld.buildings.map(bl => bl.id === matchingBarracks.id
        ? { ...bl, id: `${tag}-${barracksType}-${unlock}`, level: unlock }
        : bl)
    } else {
      const spot = barracksType === 'mystic_barracks' ? { gridX: 3, gridY: 3 } : { gridX: 18, gridY: 3 }
      troopWorld.buildings.push({ id: `${tag}-${barracksType}-${unlock}`, type: barracksType, ...spot, level: unlock })
    }
    // A watchtower opens the map sight the bot raid below needs (the eco
    // flow's pattern). Level 2 (5x5 horizon): with many guest plots allocated
    // by earlier checks, the immediate 3x3 ring can fill up with players.
    troopWorld.buildings.push({ id: `${tag}-watch`, type: 'watchtower', gridX: 2, gridY: 18, level: 2 })
    const troopSaved = await api('POST', '/world/save', { token: session.token, body: { world: troopWorld, requestId: `${tag}-barracks` } })
    ok(troopSaved.status === 200 && troopSaved.json.world.buildings.some(bl => bl.id === `${tag}-${barracksType}-${unlock}` && bl.level === unlock),
      `a funded level-${unlock} ${faction} barracks placement is accepted for ${type} (${troopSaved.status})`)
    const troopTrained = await api('POST', '/army/train', { token: session.token, body: { type, count: 1, requestId: `${tag}-train` } })
    ok(troopTrained.status === 200 && troopTrained.json.army?.[type] === 1,
      `a ${type} trains once the barracks reaches level ${unlock} (${troopTrained.status})`)
    const troopMap = (await api('GET', `/map?x=${session.player.plotX}&y=${session.player.plotY}&r=2`, { token: session.token })).json
    const troopCamp = troopMap.plots.find(plot => plot.kind === 'bot')
    ok(Boolean(troopCamp), `a nearby camp is visible for the ${type} deployment raid`)
    const troopRaid = (await api('POST', '/attacks/bot-start', { token: session.token, body: { x: troopCamp.x, y: troopCamp.y, requestId: `${tag}-bot-start` } })).json
    const troopDeploy = await api('POST', '/attacks/commands', { token: session.token, body: {
      attackId: troopRaid.raidId,
      commands: [{ type: 'DEPLOY', commandId: `${tag}-deploy-1`, sequence: 1, troopInstanceId: `${tag}_t1`, troopType: type, gridX: 0, gridY: 0 }]
    } })
    ok(troopDeploy.status === 200 && troopDeploy.json.phase === 'ACTIVE',
      `a reserved ${type} deploys through /attacks/commands (${troopDeploy.status})`)
    await api('POST', '/attacks/bot-settle', { token: session.token, body: { raidId: troopRaid.raidId, x: troopCamp.x, y: troopCamp.y, destruction: 0, deployed: { [type]: 1 }, requestId: `${tag}-bot-settle` } })
  }

  // GENERATED-ONLY GATE — skeleton (the necromancer's summon) mirrors the
  // romanwarrior rules: never trainable, dropped by sanitizeArmy, and a
  // direct deploy is rejected because it can never be reserved.
  const sk = (await api('POST', '/auth/session')).json
  for (const type of ['romanwarrior', 'skeleton']) {
    const generatedTrain = await api('POST', '/army/train', {
      token: sk.token,
      body: { type, count: 1, requestId: `${type}-generated-train` }
    })
    ok(generatedTrain.status === 404,
      `${type} is generated-only and cannot be trained (${generatedTrain.status})`)
  }
  await api('POST', '/resources/apply', { token: sk.token, body: { delta: 5000, reason: 'debug_grant', requestId: 'sk-gold' } })
  await api('POST', '/resources/apply', { token: sk.token, body: { delta: 1000, resource: 'ore', reason: 'debug_grant', requestId: 'sk-ore' } })
  await api('POST', '/resources/apply', { token: sk.token, body: { delta: 100, resource: 'food', reason: 'debug_grant', requestId: 'sk-food' } })
  const skWorld = (await api('GET', '/world', { token: sk.token })).json.world
  skWorld.buildings.push({ id: 'sk_watch', type: 'watchtower', gridX: 2, gridY: 18, level: 2 })
  await api('POST', '/world/save', { token: sk.token, body: { world: skWorld, requestId: 'sk-watch' } })
  await api('POST', '/army/train', { token: sk.token, body: { type: 'warrior', count: 1, requestId: 'sk-warrior' } })
  const skMap = (await api('GET', `/map?x=${sk.player.plotX}&y=${sk.player.plotY}&r=2`, { token: sk.token })).json
  const skCamp = skMap.plots.find(plot => plot.kind === 'bot')
  ok(Boolean(skCamp), 'a nearby camp is visible for the skeleton rejection raid')
  const skRaid = (await api('POST', '/attacks/bot-start', { token: sk.token, body: { x: skCamp.x, y: skCamp.y, requestId: 'sk-bot-start' } })).json
  const skDeploy = await api('POST', '/attacks/commands', { token: sk.token, body: {
    attackId: skRaid.raidId,
    commands: [{ type: 'DEPLOY', commandId: 'sk-deploy-1', sequence: 1, troopInstanceId: 'sk_t1', troopType: 'skeleton', gridX: 0, gridY: 0 }]
  } })
  ok(skDeploy.status === 409, `a skeleton can never be reserved, so a direct deploy is rejected (${skDeploy.status})`)

  // Frequent reads must not floor away each short production slice. A level-2
  // farm makes 1+ food over this interval, while every individual poll sees
  // much less than one unit.
  const accrualWorld = (await api('GET', '/world', { token: eco.token })).json.world
  accrualWorld.buildings.push({ id: 'fractional_farm', type: 'farm', gridX: 18, gridY: 2, level: 2 })
  const accrualSaved = (await api('POST', '/world/save', {
    token: eco.token,
    body: { world: accrualWorld, requestId: 'fractional-farm-save' }
  })).json.world
  const foodBeforeFrequentPolls = accrualSaved.resources.food
  for (let poll = 0; poll < 45; poll++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    await api('GET', '/world', { token: eco.token })
  }
  const foodAfterFrequentPolls = (await api('GET', '/world', { token: eco.token })).json.world.resources.food
  ok(foodAfterFrequentPolls >= foodBeforeFrequentPolls + 1,
    'fractional farm output survives frequent world polling')

  // Battle consumption: the frames name the troops that marched; the server takes them.
  const ecoVictim = (await api('POST', '/auth/session')).json
  const march = (await api('POST', '/attacks/matchmake', { token: eco.token, body: { requestId: 'eco-march' } })).json
  const marchTroops = t => [
    { id: 'w1', type: 'warrior', level: 1, owner: 'PLAYER', gridX: 2, gridY: 2, health: 100, maxHealth: 100 },
    { id: 'rw1', type: 'romanwarrior', level: 1, owner: 'PLAYER', gridX: 4, gridY: 2, health: 60, maxHealth: 60 }
  ].map(tr => ({ ...tr, gridX: tr.gridX + t / 1000 }))
  await api('POST', '/attacks/frames', { token: eco.token, body: { attackId: march.attackId, frames: [
    { t: 200, destruction: 5, goldLooted: 0, buildings: [], troops: marchTroops(200) },
    { t: 700, destruction: 10, goldLooted: 0, buildings: [], troops: marchTroops(700) }
  ] } })
  const marchEnd = (await api('POST', '/attacks/end', { token: eco.token, body: { attackId: march.attackId, destruction: 10, goldLooted: 0, status: 'finished' } })).json
  ok((marchEnd.army?.warrior ?? 0) === 0,
    `battle consumption takes the deployed warrior (${JSON.stringify(marchEnd.army)})`)
  const armyAfterMarch = (await api('GET', '/world', { token: eco.token })).json.world.army
  ok((armyAfterMarch.warrior ?? 0) === 0 && Object.keys(armyAfterMarch).every(k => k !== 'romanwarrior'),
    'phalanx soldiers are not consumed (they were never trained)')

  // Bot camps: deterministic loot, capped, once per cooldown; never a player plot.
  const botSeedAt = (x, y) => {
    if (x === 0 && y === 0) return null
    let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h = (h ^ (h >>> 16)) >>> 0
    const near = Math.max(Math.abs(x), Math.abs(y)) <= 2
    if (!near && h % 100 >= 55) return null
    return h
  }
  await api('POST', '/resources/apply', { token: eco.token, body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'eco-watch-ore' } })
  const towerFundedWorld = (await api('GET', '/world', { token: eco.token })).json.world
  towerFundedWorld.buildings.push({ id: 'eco_watch', type: 'watchtower', gridX: 2, gridY: 18, level: 1 })
  await api('POST', '/world/save', { token: eco.token, body: { world: towerFundedWorld, requestId: 'eco-watch-save' } })
  await armWarriors(eco.token, 10, 'eco-arm-bot')
  const ecoMap = (await api('GET', `/map?x=${eco.player.plotX}&y=${eco.player.plotY}&r=1`, { token: eco.token })).json
  const camp = ecoMap.plots.find(plot => plot.kind === 'bot')
  ok(Boolean(camp), 'a nearby visible deterministic camp is available for the bot raid')
  const directBotSettle = await api('POST', '/attacks/bot-settle', { token: eco.token, body: { x: camp.x, y: camp.y, destruction: 100, deployed: { warrior: 10 } } })
  ok(directBotSettle.status === 400, 'bot settlement is denied without a server-issued raid session')
  const botStart = (await api('POST', '/attacks/bot-start', { token: eco.token, body: { x: camp.x, y: camp.y, requestId: 'eco-bot-start-1' } })).json
  ok(botStart.raidId && botStart.x === camp.x && botStart.seed === camp.seed, 'a visible camp starts a server-issued bot raid')
  const botStartRetry = (await api('POST', '/attacks/bot-start', { token: eco.token, body: { x: camp.x, y: camp.y, requestId: 'eco-bot-start-1' } })).json
  ok(botStartRetry.raidId === botStart.raidId && JSON.stringify(botStartRetry.world) === JSON.stringify(botStart.world),
    'bot-start retry returns the same session and deterministic seeded world')
  const botFocus = await api('GET', `/map?x=${camp.x}&y=${camp.y}&r=1`, { token: eco.token })
  ok(botFocus.status === 200 && botFocus.json.plots.length === 9, 'a visible active bot raid authorizes its full battle focus ring')
  ok((await api('POST', '/attacks/start', { token: eco.token, body: { targetId: ecoVictim.player.id } })).status === 409,
    'PvP cannot start while a bot raid reserves the army')
  ok((await api('POST', '/map/relocate', { token: eco.token, body: {} })).status === 409,
    'a player cannot relocate during an active bot raid')
  const botCommand = {
    type: 'DEPLOY', commandId: 'eco-bot-root-one', sequence: 1,
    troopInstanceId: 'eco-bot-root-one', troopType: 'warrior', gridX: 0, gridY: 0
  }
  const commandedBot = (await api('POST', '/attacks/commands', {
    token: eco.token,
    body: { attackId: botStart.raidId, commands: [botCommand] }
  })).json
  ok(commandedBot.raidId === botStart.raidId && commandedBot.phase === 'ACTIVE' && commandedBot.lastCommandSequence === 1,
    'bot raids deploy through the same compact attack command endpoint')
  const retriedBotCommand = (await api('POST', '/attacks/commands', {
    token: eco.token,
    body: { attackId: botStart.raidId, commands: [botCommand] }
  })).json
  ok(retriedBotCommand.receipts?.[0]?.duplicate === true && retriedBotCommand.lastCommandSequence === 1,
    'bot deployment command retries are idempotent')
  const zeroBot = (await api('POST', '/attacks/bot-settle', { token: eco.token, body: { raidId: botStart.raidId, x: camp.x, y: camp.y, destruction: 0, deployed: { warrior: 10 }, requestId: 'eco-bot-settle-1' } })).json
  ok((zeroBot.army?.warrior ?? 0) === 0 && zeroBot.lootApplied >= 0,
    'the compatibility bridge consumes deployed roots while client destruction cannot suppress the deterministic result')
  const zeroRetry = (await api('POST', '/attacks/bot-settle', { token: eco.token, body: { raidId: botStart.raidId, requestId: 'eco-bot-settle-1' } })).json
  ok(zeroRetry.lootApplied === zeroBot.lootApplied && JSON.stringify(zeroRetry.army) === JSON.stringify(zeroBot.army),
    'settled bot raid retries return the persisted result without applying twice')
  ok((await api('POST', '/attacks/bot-start', { token: eco.token, body: { x: camp.x, y: camp.y, requestId: 'eco-bot-start-1' } })).status === 409,
    'a finished bot start request is never replayed as a fresh live raid')
  await armWarriors(eco.token, 10, 'eco-arm-cloud-bot')
  ok((await api('POST', '/attacks/bot-start', { token: eco.token, body: { x: camp.x, y: camp.y, requestId: 'eco-bot-cooldown' } })).status === 409,
    'the camp cooldown survives the session layer')
  const cloudBot = (await api('POST', '/attacks/bot-start', { token: eco.token, body: { requestId: 'eco-cloud-bot' } })).json
  ok(cloudBot.raidId && Math.max(Math.abs(cloudBot.x - eco.player.plotX), Math.abs(cloudBot.y - eco.player.plotY)) > 1,
    'cloud bot-start returns a valid server-selected remote camp session')
  const cloudBotFocus = await api('GET', `/map?x=${cloudBot.x}&y=${cloudBot.y}&r=1`, { token: eco.token })
  ok(cloudBotFocus.status === 200
    && cloudBotFocus.json.plots.some(plot => plot.x === cloudBot.x && plot.y === cloudBot.y),
    'a cloud bot session authorizes its canonical target-centered local battle focus')
  const instantCloud = (await api('POST', '/attacks/bot-settle', { token: eco.token, body: { raidId: cloudBot.raidId, destruction: 100, deployed: { warrior: 10 }, requestId: 'eco-cloud-settle' } })).json
  ok(instantCloud.lootApplied < Math.floor((cloudBot.world.resources.gold ?? 0) * 0.2),
    'an immediate 100% bot claim cannot elevate the deterministic first-volley result to full loot')
  await armWarriors(eco.token, 1, 'eco-arm-invalid-bot')
  const invalidBot = (await api('POST', '/attacks/bot-start', { token: eco.token, body: { requestId: 'eco-invalid-bot' } })).json
  const inventedBotArmy = await api('POST', '/attacks/bot-settle', { token: eco.token, body: { raidId: invalidBot.raidId, destruction: 100, deployed: { golem: 1 }, requestId: 'eco-invalid-settle' } })
  ok(inventedBotArmy.status === 409, 'bot settlement rejects deployed troops outside the reserved army')
  await api('POST', '/attacks/bot-settle', { token: eco.token, body: { raidId: invalidBot.raidId, destruction: 0, deployed: {}, requestId: 'eco-invalid-retreat' } })

  // Merchant deals are server-priced and once per world-day.
  const beforeTrade = await ecoGold()
  const deal = (await api('POST', '/merchant/trade', { token: eco.token, body: { offerId: 1, requestId: 'eco-trade-1' } })).json
  ok(deal.applied === true && deal.ore > beforeTrade.ore && deal.gold < beforeTrade.gold,
    `merchant deal 1 swaps gold for ore at the server's price (${beforeTrade.gold}->${deal.gold}, ${beforeTrade.ore}->${deal.ore})`)
  for (let i = 0; i < 405; i++) {
    await api('POST', '/resources/apply', { token: eco.token, body: { delta: -1, requestId: `merchant-evict-${i}` } })
  }
  const dealAgain = await api('POST', '/merchant/trade', { token: eco.token, body: { offerId: 1, requestId: 'eco-trade-2' } })
  ok(dealAgain.status === 409, 'merchant redemption survives generic request-key eviction for the whole day')
  ok((await api('POST', '/merchant/trade', { token: eco.token, body: { offerId: 9 } })).status === 404, 'an invented deal is refused')

  // Raidable stocks: ore/food join the loot table, storehouses shield a share.
  const stockVictim = (await api('POST', '/auth/session')).json
  const stockRaider = (await api('POST', '/auth/session')).json
  // Give the victim visible stocks and a storehouse (20% protection at L1).
  await api('POST', '/resources/apply', { token: stockVictim.token, body: { delta: 5000, reason: 'debug_grant', requestId: 'sv-g' } })
  await api('POST', '/resources/apply', { token: stockVictim.token, body: { delta: 100, resource: 'ore', reason: 'debug_grant', requestId: 'sv-o' } })
  const svWorld = (await api('GET', '/world', { token: stockVictim.token })).json.world
  svWorld.buildings.push({ id: 'sv_store', type: 'storage', gridX: 18, gridY: 2, level: 1 })
  await api('POST', '/world/save', { token: stockVictim.token, body: { world: svWorld, requestId: 'sv-save' } })
  await api('POST', '/resources/apply', { token: stockVictim.token, body: { delta: 275, resource: 'ore', reason: 'debug_grant', requestId: 'sv-o2' } })
  await api('POST', '/resources/apply', { token: stockVictim.token, body: { delta: 150, resource: 'food', reason: 'debug_grant', requestId: 'sv-f' } })
  const svBefore = (await api('GET', '/world', { token: stockVictim.token })).json.world.resources
  await armWarriors(stockRaider.token, 50, 'arm-stock-raider')
  const stockRaiderBefore = (await api('GET', '/world', { token: stockRaider.token })).json.world.resources
  const raidStart = await matchmakeUntil(stockRaider.token, stockVictim.player.id, 'stock-raid')
  // Caps: 20% of stocks, then the storehouse shields 20% of that.
  const expectOreCap = Math.floor(svBefore.ore * 0.2 * 0.8)
  const expectFoodCap = Math.floor(svBefore.food * 0.2 * 0.8)
  await api('POST', '/attacks/frames', { token: stockRaider.token, body: { attackId: raidStart.attackId, frames: validBattleFrames(raidStart, 50, 3, 100) } })
  const lockedSpend = await api('POST', '/resources/apply', {
    token: stockVictim.token,
    body: { delta: -1, requestId: 'victim-mid-raid-spend' }
  })
  ok(lockedSpend.status === 409 && lockedSpend.json.code === 'BASE_UNDER_ATTACK',
    'a deployed incoming raid locks defender spending so displayed loot cannot be denied')
  const lockedLayout = (await api('GET', '/world', { token: stockVictim.token })).json.world
  const lockedSave = await api('POST', '/world/save', {
    token: stockVictim.token,
    body: { world: lockedLayout, requestId: 'victim-mid-raid-save' }
  })
  ok(lockedSave.status === 409 && lockedSave.json.code === 'BASE_UNDER_ATTACK',
    'a deployed incoming raid freezes the defender layout until settlement')
  await new Promise(resolve => setTimeout(resolve, 1200))
  const raidEnd = (await api('POST', '/attacks/end', { token: stockRaider.token, body: { attackId: raidStart.attackId, destruction: 60, goldLooted: 50, oreLooted: 9999, foodLooted: 9999, status: 'finished' } })).json
  ok(raidEnd.oreApplied > 0 && raidEnd.oreApplied <= expectOreCap && raidEnd.foodApplied > 0 && raidEnd.foodApplied <= expectFoodCap,
    `ore/food loot is elapsed-time bounded below the protected caps (${raidEnd.oreApplied}/${expectOreCap}, ${raidEnd.foodApplied}/${expectFoodCap})`)
  const svAfter = (await api('GET', '/world', { token: stockVictim.token })).json.world.resources
  ok(svAfter.ore === svBefore.ore - raidEnd.oreApplied && svAfter.food === svBefore.food - raidEnd.foodApplied,
    'the victim loses exactly what the raider carried')
  const raiderAfter = (await api('GET', '/world', { token: stockRaider.token })).json.world.resources
  ok(raiderAfter.ore === Math.min(150, stockRaiderBefore.ore + raidEnd.oreApplied) && raiderAfter.food === Math.min(200, stockRaiderBefore.food + raidEnd.foodApplied),
    'carried stocks land in the raider stores, clamped by their own capacity')
  const svNotif = (await api('GET', '/notifications', { token: stockVictim.token })).json.items[0]
  ok(svNotif.oreLost === raidEnd.oreApplied && svNotif.foodLost === raidEnd.foodApplied,
    'the defender is told which stocks were carried off')

  // The open faucet is closed: arbitrary grants are refused, ambient ones capped.
  const freeMoney = await api('POST', '/resources/apply', { token: eco.token, body: { delta: 999999, reason: 'battle_loot', requestId: 'eco-faucet-1' } })
  ok(freeMoney.status === 403, `arbitrary positive grants are refused (${freeMoney.status})`)
  const bigEgg = await api('POST', '/resources/apply', { token: eco.token, body: { delta: 200, resource: 'food', reason: 'egg_collect', requestId: 'eco-egg-1' } })
  ok(bigEgg.status === 403, 'an oversized ambient grant is refused')
  const egg = (await api('POST', '/resources/apply', { token: eco.token, body: { delta: 5, resource: 'food', reason: 'egg_collect', requestId: 'eco-egg-2' } })).json
  ok(egg.applied === true, 'a real egg still lands in the pantry')

  // The economy ledger has been watching all of it.
  console.log('\nEconomy ledger:')
  const sheet = (await api('GET', '/economy/ledger?days=2', { token: eco.token })).json
  ok(Array.isArray(sheet.days) && sheet.days.length === 2 && sheet.days[0].day === sheet.today,
    'the ledger returns the requested window, today first')
  const today = sheet.days[0]
  ok(today.sinks.gold > 0 && today.sinks.ore > 0, `building purchases were booked as sinks (${today.sinks.gold} gold, ${today.sinks.ore} ore)`)
  ok(today.refunds.gold > 0, `demolition/untrain refunds were booked (${today.refunds.gold} gold)`)
  ok(today.loot.ore > 0 && today.loot.food > 0, `raided stocks were booked as transfers (${today.loot.ore} ore, ${today.loot.food} food)`)
  ok(today.faucets.gold > 0, `bot loot and grants were booked as faucets (${today.faucets.gold} gold)`)
  ok(today.counts.battles > 0 && today.counts.trades > 0 && today.counts.botRaids > 0,
    `activity counters tick (${today.counts.battles} battles, ${today.counts.trades} trades, ${today.counts.botRaids} bot raids)`)

  // Exercise the lease with a tiny test-only window. Empty forward frames are
  // stored for replay ordering but must not refresh a deployed victim lock.
  await stopServer()
  await startServer({ CLASH_LIVE_ATTACK_STALE_MS: '120', CLASH_GUEST_LIMIT_PER_HOUR: '30' })
  const leaseVictim = (await api('POST', '/auth/session', { body: {} })).json
  const leaseRaider = (await api('POST', '/auth/session', { body: {} })).json
  await armWarriors(leaseRaider.token, 1, 'arm-empty-lease')
  const leaseAttack = await matchmakeUntil(leaseRaider.token, leaseVictim.player.id, 'empty-lease')
  await api('POST', '/attacks/frames', { token: leaseRaider.token, body: { attackId: leaseAttack.attackId, frames: [rootFrame(leaseAttack.attackId, 'lease-root', 10)] } })
  await new Promise(resolve => setTimeout(resolve, 60))
  await api('POST', '/attacks/frames', { token: leaseRaider.token, body: { attackId: leaseAttack.attackId, frames: [{ t: 20, destruction: 0, goldLooted: 0, buildings: [], troops: [] }] } })
  await new Promise(resolve => setTimeout(resolve, 90))
  const afterEmptyLease = (await api('GET', '/attacks/incoming', { token: leaseVictim.token })).json
  ok(!afterEmptyLease.sessions?.some(session => session.attackId === leaseAttack.attackId),
    'empty frames cannot refresh and hold an exclusive victim lease')

  console.log('\nAbuse limits:')
  let limited = null
  for (let i = 0; i <= 30; i++) {
    limited = await api('POST', '/auth/session', { headers: { 'X-Forwarded-For': '198.51.100.99' } })
  }
  ok(limited.status === 429, 'anonymous village creation is rate-limited per network address')

  console.log('\nDevelopment world reseed:')
  await stopServer()
  await startServer({ CLASH_ALLOW_WORLD_RESEED: '1', CLASH_GUEST_LIMIT_PER_HOUR: '10000' })
  const reseedCaller = (await api('POST', '/auth/session', {
    headers: { 'X-Forwarded-For': '198.51.100.121' }
  })).json
  const disposableGuest = (await api('POST', '/auth/session', {
    headers: { 'X-Forwarded-For': '198.51.100.122' }
  })).json
  await api('POST', '/resources/apply', {
    token: reseedCaller.token,
    body: { delta: 2000, reason: 'debug_grant', requestId: 'reseed-eyes-gold' }
  })
  await api('POST', '/resources/apply', {
    token: reseedCaller.token,
    body: { delta: 125, resource: 'ore', reason: 'debug_grant', requestId: 'reseed-eyes-ore' }
  })
  const reseedWorldBefore = (await api('GET', '/world', { token: reseedCaller.token })).json.world
  reseedWorldBefore.buildings.push({ id: 'reseed_eyes', type: 'watchtower', gridX: 2, gridY: 2, level: 1 })
  const savedReseedWorld = (await api('POST', '/world/save', {
    token: reseedCaller.token,
    body: { world: reseedWorldBefore, requestId: 'reseed-eyes-save' }
  })).json.world
  const callerBuildings = JSON.stringify(savedReseedWorld.buildings)
  const mapBeforeReseed = (await api(
    'GET',
    `/map?x=${reseedCaller.player.plotX}&y=${reseedCaller.player.plotY}&r=1`,
    { token: reseedCaller.token }
  )).json
  const generatedTopologySignature = map => map.plots
    .filter(plot => plot.kind !== 'player')
    .map(plot => `${plot.x},${plot.y}:${plot.kind}:${plot.kind === 'bot' ? plot.seed : plot.settleable}`)
    .sort()
    .join('|')
  const botCoordinateSignature = map => map.plots
    .filter(plot => plot.kind === 'bot')
    .map(plot => `${plot.x},${plot.y}`)
    .sort()
    .join('|')
  const topologyBeforeReseed = generatedTopologySignature(mapBeforeReseed)
  const botsBeforeReseed = botCoordinateSignature(mapBeforeReseed)
  const generatedBeforeReseed = mapBeforeReseed.plots.find(plot => plot.kind === 'bot')
  ok(Boolean(generatedBeforeReseed) && Number.isSafeInteger(generatedBeforeReseed.seed),
    'the reseed regression observes a deterministic generated village')
  const registeredBefore = (await api('GET', '/world', { token: guest.token })).json.world
  const reseeded = await api('POST', '/debug/reseed-world', { token: reseedCaller.token })
  ok(reseeded.status === 200 && reseeded.json.ok === true && reseeded.json.removedGuests >= 1,
    'the authenticated development endpoint removes other guest villages')
  const mapAfterReseed = (await api(
    'GET',
    `/map?x=${reseedCaller.player.plotX}&y=${reseedCaller.player.plotY}&r=1`,
    { token: reseedCaller.token }
  )).json
  const topologyAfterReseed = generatedTopologySignature(mapAfterReseed)
  const botsAfterReseed = botCoordinateSignature(mapAfterReseed)
  ok(Number.isInteger(reseeded.json.seedVersion) && reseeded.json.seedVersion === mapAfterReseed.seedVersion
    && topologyAfterReseed !== topologyBeforeReseed
    && botsAfterReseed !== botsBeforeReseed,
    'reseed advances a durable epoch and moves generated bot occupancy/topology')
  ok(mapAfterReseed.plots.some(plot => plot.kind === 'player'
    && plot.ownerId === reseedCaller.player.id
    && plot.x === reseedCaller.player.plotX
    && plot.y === reseedCaller.player.plotY),
    'the real caller plot overrides any generated topology at its pinned coordinate')
  ok(reseeded.json.preservedPlayers >= 2 && reseeded.json.removedActivity.attacks > 0,
    'world reseed preserves real players and clears multiplayer history referencing removed guests')
  const callerAfterReseed = await api('POST', '/auth/session', { body: { token: reseedCaller.token } })
  ok(callerAfterReseed.status === 200 && callerAfterReseed.json.player.id === reseedCaller.player.id
    && callerAfterReseed.json.player.plotX === reseedCaller.player.plotX
    && callerAfterReseed.json.player.plotY === reseedCaller.player.plotY
    && JSON.stringify(callerAfterReseed.json.world.buildings) === callerBuildings,
  'the unregistered caller and its exact village survive reseeding')
  const registeredAfterReseed = await api('POST', '/auth/session', { body: { token: guest.token } })
  ok(registeredAfterReseed.status === 200
    && registeredAfterReseed.json.player.plotX === guest.player.plotX
    && registeredAfterReseed.json.player.plotY === guest.player.plotY
    && JSON.stringify(registeredAfterReseed.json.world.buildings) === JSON.stringify(registeredBefore.buildings),
  'registered accounts and their exact villages survive reseeding')
  ok((await api('GET', '/world', { token: disposableGuest.token })).status === 401,
    'removed guest sessions cannot return after reseeding')

  // The old implementation returned early here, making the button visibly do
  // nothing as soon as there were no disposable guest records left.
  const reseededAgain = await api('POST', '/debug/reseed-world', { token: reseedCaller.token })
  const mapAfterSecondReseed = (await api(
    'GET',
    `/map?x=${reseedCaller.player.plotX}&y=${reseedCaller.player.plotY}&r=1`,
    { token: reseedCaller.token }
  )).json
  const topologyAfterSecondReseed = generatedTopologySignature(mapAfterSecondReseed)
  const botsAfterSecondReseed = botCoordinateSignature(mapAfterSecondReseed)
  ok(reseededAgain.status === 200 && reseededAgain.json.removedGuests === 0
    && reseededAgain.json.seedVersion === reseeded.json.seedVersion + 1
    && topologyAfterSecondReseed !== topologyAfterReseed
    && botsAfterSecondReseed !== botsAfterReseed,
    'reseed rebuilds generated occupancy again when there are no guest records to delete')

  await stopServer()
  await startServer({ CLASH_ALLOW_WORLD_RESEED: '0', CLASH_GUEST_LIMIT_PER_HOUR: '10000' })
  const mapAfterReseedRestart = (await api(
    'GET',
    `/map?x=${reseedCaller.player.plotX}&y=${reseedCaller.player.plotY}&r=1`,
    { token: reseedCaller.token }
  )).json
  ok(mapAfterReseedRestart.seedVersion === reseededAgain.json.seedVersion
    && generatedTopologySignature(mapAfterReseedRestart) === topologyAfterSecondReseed
    && botCoordinateSignature(mapAfterReseedRestart) === botsAfterSecondReseed,
    'the generated-world topology epoch and exact occupancy survive restart')
  const callerAfterRestart = await api('POST', '/auth/session', { body: { token: reseedCaller.token } })
  ok(callerAfterRestart.status === 200
    && callerAfterRestart.json.player.plotX === reseedCaller.player.plotX
    && callerAfterRestart.json.player.plotY === reseedCaller.player.plotY
    && JSON.stringify(callerAfterRestart.json.world.buildings) === callerBuildings,
    'the pinned unregistered caller keeps its exact plot and village through a topology restart')
  ok((await api('POST', '/debug/reseed-world', { token: reseedCaller.token })).status === 404,
    'the destructive reseed route is absent when the development flag is disabled')

  console.log('\nDevelopment infinite resources:')
  await stopServer()
  await startServer({
    CLASH_ALLOW_DEBUG_GRANTS: '0',
    CLASH_INFINITE_RESOURCES: '1',
    CLASH_GUEST_LIMIT_PER_HOUR: '10000'
  })
  const infinite = (await api('POST', '/auth/session', { body: {} })).json
  const infiniteInitial = { ...infinite.world.resources }
  ok(infinite.features?.infiniteResources === true,
    'the authenticated session advertises server-authorized infinite resources')
  ok(infiniteInitial.gold === 1000 && infiniteInitial.ore === 25 && infiniteInitial.food === 50,
    'infinite mode keeps ordinary finite balances instead of persisting a sentinel')
  ok((await api('POST', '/resources/apply', {
    token: infinite.token,
    body: { delta: 100, reason: 'debug_grant', requestId: 'infinite-debug-grant' }
  })).status === 403,
  'infinite spending is independent from the disabled debug-grant faucet')

  const infiniteSpend = (await api('POST', '/resources/apply', {
    token: infinite.token,
    body: { delta: -999999, reason: 'client_spend', requestId: 'infinite-negative' }
  })).json
  const infiniteSpendReplay = (await api('POST', '/resources/apply', {
    token: infinite.token,
    body: { delta: -999999, reason: 'client_spend', requestId: 'infinite-negative' }
  })).json
  ok(infiniteSpend.gold === infiniteInitial.gold
    && infiniteSpend.ore === infiniteInitial.ore
    && infiniteSpend.food === infiniteInitial.food,
  'an otherwise-impossible direct spend is accepted without a debit')
  ok(JSON.stringify(infiniteSpendReplay) === JSON.stringify(infiniteSpend),
    'the waived direct spend remains idempotent')

  const infiniteBeforePlacement = (await api('GET', '/world', { token: infinite.token })).json.world
  const infinitePlacement = await api('POST', '/world/save', {
    token: infinite.token,
    body: {
      world: {
        ...infiniteBeforePlacement,
        buildings: [
          ...infiniteBeforePlacement.buildings,
          { id: 'infinite_storage', type: 'storage', gridX: 2, gridY: 18, level: 1 }
        ]
      },
      requestId: 'infinite-place-storage'
    }
  })
  const infinitePlaced = infinitePlacement.json?.world
  ok(infinitePlacement.status === 200
    && infinitePlaced.buildings.some(building => building.id === 'infinite_storage')
    && infinitePlaced.resources.gold === infiniteInitial.gold
    && infinitePlaced.resources.ore === infiniteInitial.ore,
  'a 40-ore storehouse can be placed from the starter 25 ore without charging')

  const infiniteUpgrade = await api('POST', '/world/save', {
    token: infinite.token,
    body: {
      world: {
        ...infinitePlaced,
        buildings: infinitePlaced.buildings.map(building => (
          building.id === 'infinite_storage' ? { ...building, level: 2 } : building
        ))
      },
      requestId: 'infinite-upgrade-storage'
    }
  })
  const infiniteUpgraded = infiniteUpgrade.json?.world
  const infinitePendingStorage = infiniteUpgraded?.buildings.find(building => building.id === 'infinite_storage')
  ok(infiniteUpgrade.status === 200
    && infinitePendingStorage?.level === 1
    && infinitePendingStorage?.upgradingTo === 2
    && infiniteUpgraded.resources.gold === infiniteInitial.gold
    && infiniteUpgraded.resources.ore === infiniteInitial.ore,
  'an otherwise-unaffordable storehouse upgrade starts without a debit')

  const infiniteArmy = await api('POST', '/army/train', {
    token: infinite.token,
    body: { type: 'warrior', count: 50, requestId: 'infinite-train-capacity' }
  })
  ok(infiniteArmy.status === 200
    && infiniteArmy.json.army.warrior === 50
    && infiniteArmy.json.gold === infiniteInitial.gold
    && infiniteArmy.json.food === infiniteInitial.food,
  'training beyond starter gold and food succeeds without charging')
  const infiniteOverHousing = await api('POST', '/army/train', {
    token: infinite.token,
    body: { type: 'warrior', count: 1, requestId: 'infinite-over-housing' }
  })
  ok(infiniteOverHousing.status === 409,
    'infinite resources do not grant infinite army housing')

  const infiniteTrade = (await api('POST', '/merchant/trade', {
    token: infinite.token,
    body: { offerId: 1, requestId: 'infinite-merchant' }
  })).json
  const infiniteTradeReplay = (await api('POST', '/merchant/trade', {
    token: infinite.token,
    body: { offerId: 1, requestId: 'infinite-merchant' }
  })).json
  ok(infiniteTrade.applied === true
    && infiniteTrade.gold === infiniteInitial.gold
    && infiniteTrade.ore === infiniteInitial.ore
    && infiniteTrade.food === infiniteInitial.food,
  'a merchant redemption records its state without moving infinite resources')
  ok(JSON.stringify(infiniteTradeReplay) === JSON.stringify(infiniteTrade),
    'the infinite merchant redemption replays idempotently')
  ok((await api('POST', '/merchant/trade', {
    token: infinite.token,
    body: { offerId: 1, requestId: 'infinite-merchant-second-key' }
  })).status === 409,
  'the once-per-day merchant rule still applies in infinite mode')

  await stopServer()
  await startServer({
    CLASH_ALLOW_DEBUG_GRANTS: '0',
    CLASH_INFINITE_RESOURCES: '0',
    CLASH_GUEST_LIMIT_PER_HOUR: '10000'
  })
  const finiteResume = (await api('POST', '/auth/session', {
    body: { token: infinite.token }
  })).json
  ok(finiteResume.features?.infiniteResources === false
    && finiteResume.world.resources.gold === infiniteInitial.gold
    && finiteResume.world.resources.ore === infiniteInitial.ore
    && finiteResume.world.resources.food === infiniteInitial.food,
  'disabling the flag reveals the unchanged finite stored balances')
  const finiteSpend = (await api('POST', '/resources/apply', {
    token: infinite.token,
    body: { delta: -10, reason: 'client_spend', requestId: 'finite-negative-control' }
  })).json
  ok(finiteSpend.gold === infiniteInitial.gold - 10,
    'the same direct spend debits normally after infinite mode is disabled')
  const finiteWorld = (await api('GET', '/world', { token: infinite.token })).json.world
  const finiteMine = await api('POST', '/world/save', {
    token: infinite.token,
    body: {
      world: {
        ...finiteWorld,
        buildings: [
          ...finiteWorld.buildings,
          { id: 'finite_mine_control', type: 'mine', gridX: 6, gridY: 18, level: 1 }
        ]
      },
      requestId: 'finite-place-mine-control'
    }
  })
  ok(finiteMine.status === 409 && finiteMine.json?.code === 'INSUFFICIENT_RESOURCES',
    'finite mode again rejects a 35-ore mine at the stored 25 ore balance')

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch(error => {
    console.error('\nTest run failed:', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await stopServer()
    rmSync(dataDir, { recursive: true, force: true })
  })
