import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    ALWAYS_RESIDENT_RING,
    PLAYER_POSTCARD_RGBA_BYTES,
    PLAYER_POSTCARD_SCALE,
    POSTCARD_EVICTION_GRACE_MS,
    decidePostcardResidency,
    estimateVillageTextureBytes,
    isRevealPostcardReady,
    playerPostcardBounds
} from '../src/game/systems/WorldPostcardResidency';

const camera = { x: -640, y: 40, width: 1_280, height: 720 };

assert.equal(PLAYER_POSTCARD_SCALE, 1, 'player villages must never be downsampled');
assert.equal(PLAYER_POSTCARD_RGBA_BYTES, 5_696_000, 'texture budget changed without updating instrumentation');
assert.deepEqual(playerPostcardBounds(0, 0), { x: -800, y: -90, width: 1_600, height: 890 });

let required = 0;
let initiallyInterested = 0;
for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
        if (dx === 0 && dy === 0) continue;
        const decision = decidePostcardResidency({
            dx,
            dy,
            camera,
            now: 10_000,
            lastInterestedAt: 10_000,
            resident: false
        });
        if (decision.required) required++;
        if (decision.interested) initiallyInterested++;
    }
}
assert.equal(required, 8, 'the active 3x3 ring must remain permanently resident');
assert.equal(initiallyInterested, 8, 'the centered camera should defer all sixteen ring-2 postcards');

const fullFiveByFive = estimateVillageTextureBytes(24);
const centeredResident = estimateVillageTextureBytes(initiallyInterested);
assert.equal(fullFiveByFive, 136_704_000);
assert.equal(centeredResident, 45_568_000);
assert(centeredResident / fullFiveByFive < 0.34, 'centered 5x5 texture budget should fall by about two thirds');

// Crossing the prefetch band materializes at full quality before visibility.
const eastCamera = { ...camera, x: 320 };
const east = decidePostcardResidency({
    dx: 2,
    dy: 0,
    camera: eastCamera,
    now: 12_000,
    lastInterestedAt: 10_000,
    resident: false
});
assert.equal(east.visible, false);
assert.equal(east.prefetched, true);
assert.equal(east.materialize, true);

// Moving away retains the texture for a grace window, then releases it.
const farCamera = { ...camera, x: -4_000 };
const grace = decidePostcardResidency({
    dx: 2,
    dy: 0,
    camera: farCamera,
    now: 12_000 + POSTCARD_EVICTION_GRACE_MS - 1,
    lastInterestedAt: 12_000,
    resident: true
});
assert.equal(grace.evict, false);
const expired = decidePostcardResidency({
    dx: 2,
    dy: 0,
    camera: farCamera,
    now: 12_000 + POSTCARD_EVICTION_GRACE_MS,
    lastInterestedAt: 12_000,
    resident: true
});
assert.equal(expired.evict, true);

const currentVillage = {
    kind: 'bot' as const,
    hasTexture: true,
    contentKind: 'village' as const,
    renderedRevision: 'bot_owner_7',
    sourceRevision: 'bot_owner_7',
    hasSourceWorld: true
};
assert.equal(isRevealPostcardReady(currentVillage), true,
    'a current rendered village may be uncovered');
assert.equal(isRevealPostcardReady({ ...currentVillage, hasTexture: false }), false,
    'source-only ring-two villages must stay behind fog');
assert.equal(isRevealPostcardReady({ ...currentVillage, contentKind: 'nature' }), false,
    'fallback nature must not stand in for a known village during reveal');
assert.equal(isRevealPostcardReady({ ...currentVillage, renderedRevision: 'bot_owner_6' }), false,
    'a stale village revision must stay behind fog');
assert.equal(isRevealPostcardReady({ ...currentVillage, hasSourceWorld: false }), false,
    'village metadata without its authoritative snapshot is not ready');

const currentNature = {
    kind: 'empty' as const,
    hasTexture: true,
    contentKind: 'nature' as const,
    renderedRevision: 'wild_9',
    sourceRevision: null,
    hasSourceWorld: false,
    expectedNatureRevision: 'wild_9'
};
assert.equal(isRevealPostcardReady(currentNature), true,
    'current deterministic wilderness may be uncovered');
assert.equal(isRevealPostcardReady({ ...currentNature, hasTexture: false }), false,
    'unmaterialized wilderness must stay behind fog');
assert.equal(isRevealPostcardReady({ ...currentNature, contentKind: 'village' }), false,
    'the wrong postcard kind must stay behind fog');
assert.equal(isRevealPostcardReady({ ...currentNature, renderedRevision: 'wild_8' }), false,
    'stale wilderness must stay behind fog');

// This source-level contract complements the pure readiness matrix above: the
// predicate is only useful if every reveal path actually waits on it.
const worldMapSource = readFileSync('src/game/systems/WorldMapSystem.ts', 'utf8');
const sightDiff = worldMapSource.slice(
    worldMapSource.indexOf('private computeViewRadius('),
    worldMapSource.indexOf('/** Re-anchor all plot-relative state', worldMapSource.indexOf('private computeViewRadius(')));
assert.match(sightDiff, /next > prev && this\.sightHydrated\) this\.queueFogReveal\(prev, next\)/,
    'a trusted Watchtower gain must queue preparation instead of opening clouds immediately');
assert.doesNotMatch(sightDiff, /next > prev[\s\S]*?beginFogReveal\(prev, next\)/,
    'the sight-diff path must not begin an unprepared reveal');

const updateSource = worldMapSource.slice(
    worldMapSource.indexOf('update(time: number)'),
    worldMapSource.indexOf('private lastDesignFingerprint'));
assert.match(updateSource, /this\.startPreparedFogReveal\(\);[\s\S]*?this\.ensureFog\(this\.pendingFogReveal\?\.fromRadius \?\? radius\)/,
    'steady updates must hold the old cloud boundary until preparation is ready');
assert.ok((updateSource.match(/this\.pendingFogReveal\?\.fromRadius/g) ?? []).length >= 2,
    'camera-cover repaints must also retain the old cloud boundary');

const refreshSource = worldMapSource.slice(
    worldMapSource.indexOf('private refresh(options:'),
    worldMapSource.indexOf('private cameraWorldRect'));
assert.match(refreshSource, /coversRadius[\s\S]*?coversTextures[\s\S]*?this\.refreshInFlight\.then\(\(\) => this\.refresh\(options\)\)/,
    'an older or non-forced in-flight poll must not satisfy a larger reveal preload');
assert.match(refreshSource, /revealCriticalOnly = !forceVillageTextures[\s\S]*?forceVillageTexture: forceVillageTextures/,
    'reveal preparation must disable deferred far painting and force village textures resident');

const preparationSource = worldMapSource.slice(
    worldMapSource.indexOf('private async preparePendingFogReveal('),
    worldMapSource.indexOf('private cancelPendingFogReveal'));
assert.match(preparationSource, /requiredRadius: pending\.toRadius,[\s\S]*?forceVillageTextures: true/,
    'reveal preparation must fetch the exact expanded radius with forced textures');
assert.match(preparationSource, /if \(!pending\?\.ready\) return;[\s\S]*?this\.beginFogReveal\(pending\.fromRadius, pending\.toRadius\)/,
    'only a fully prepared pending reveal may begin');

const fallbackSource = worldMapSource.slice(
    worldMapSource.indexOf('private ensureInitialWildernessFallback('),
    worldMapSource.indexOf('/** Load + render the whole neighbourhood'));
assert.match(fallbackSource, /ensureInitialWildernessFallback\(visibleFogRadius[\s\S]*?this\.ensureFog\(visibleFogRadius\)/,
    'network fallback art must remain beneath the held cloud boundary');

const snapshotSource = worldMapSource.slice(
    worldMapSource.indexOf('private renderSnapshot('),
    worldMapSource.indexOf('private registerVillageResidents', worldMapSource.indexOf('private renderSnapshot(')));
assert.match(snapshotSource,
    /const stoneWorld = opts\?\.staticGroundWorld \?\? world;[\s\S]*?computeStoneRoutes\(stoneBuildings\)/,
    'battle postcard repaints must be able to preserve the authoritative static lane network');
assert.match(snapshotSource,
    /includeElevatedBuildings: opts\?\.omitElevatedBuildings !== true/,
    'battle postcard RTs must be able to retain bases while yielding roofs to live depth carriers');
const battleRepaintSource = worldMapSource.slice(
    worldMapSource.indexOf('private updateWorldBattlePlaybacks('),
    worldMapSource.indexOf('private stopWorldBattlePlayback', worldMapSource.indexOf('private updateWorldBattlePlaybacks(')));
assert.match(battleRepaintSource,
    /staticGroundWorld: source/,
    'destroyed buildings may leave the battle render layer without rerouting its frozen ground lanes');
assert.match(battleRepaintSource,
    /omitElevatedBuildings: true/,
    'live battle repaint must not flatten surviving roofs into the ground postcard');
assert.match(battleRepaintSource,
    /time < view\.battlePostcardRepaintNotBefore[\s\S]*?battlePostcardRepaintNotBefore = time \+ 100/,
    'destruction bursts must coalesce expensive full-postcard corrections off the render-critical frame');

console.log('world postcard regression passed: authoritative-snapshot residency');
