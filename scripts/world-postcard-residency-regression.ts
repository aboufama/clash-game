import assert from 'node:assert/strict';
import { BOT_WORLD_GENERATION_VERSION, generateBotWorldFromSeed } from '../src/game/backend/BotWorlds';
import { BUILDING_DEFINITIONS, OBSTACLE_DEFINITIONS } from '../src/game/config/GameDefinitions';
import {
    ALWAYS_RESIDENT_RING,
    PLAYER_POSTCARD_RGBA_BYTES,
    PLAYER_POSTCARD_SCALE,
    POSTCARD_EVICTION_GRACE_MS,
    decidePostcardResidency,
    estimateVillageTextureBytes,
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

const firstBot = generateBotWorldFromSeed(9_731);
assert.deepEqual(firstBot, generateBotWorldFromSeed(9_731), 'one seed must reproduce the exact same village');
assert.notDeepEqual(firstBot, generateBotWorldFromSeed(9_732), 'different seeds should not clone a village');
assert.equal(firstBot.revision, BOT_WORLD_GENERATION_VERSION);

for (let seed = 1; seed <= 128; seed++) {
    const world = generateBotWorldFromSeed(seed);
    assert.equal(world.life?.version, 1, `seed ${seed} needs an authoritative life manifest`);
    assert.equal(world.life?.identity, `bot:${seed}`);
    assert((world.life?.population ?? 0) >= 8 && (world.life?.population ?? 0) <= 24,
        `seed ${seed} should have a visible but bounded census`);
    const obstacleTypes = new Set((world.obstacles ?? []).map(obstacle => obstacle.type));
    assert(obstacleTypes.has('grass_patch'), `seed ${seed} needs grass detail`);
    assert(obstacleTypes.has('rock_small'), `seed ${seed} needs stone detail`);
    assert(obstacleTypes.has('tree_oak') || obstacleTypes.has('tree_pine'), `seed ${seed} needs mature greenery`);

    const occupied = new Set<string>();
    const claim = (kind: string, x: number, y: number, width: number, height: number) => {
        assert(x >= 0 && y >= 0 && x + width <= 25 && y + height <= 25,
            `${kind} escaped the 25x25 village at seed ${seed}`);
        for (let dx = 0; dx < width; dx++) {
            for (let dy = 0; dy < height; dy++) {
                const key = `${x + dx},${y + dy}`;
                assert(!occupied.has(key), `${kind} overlaps occupied tile ${key} at seed ${seed}`);
                occupied.add(key);
            }
        }
    };
    for (const building of world.buildings) {
        const definition = BUILDING_DEFINITIONS[building.type];
        claim(`building ${building.id}`, building.gridX, building.gridY, definition.width, definition.height);
    }
    for (const obstacle of world.obstacles ?? []) {
        const definition = OBSTACLE_DEFINITIONS[obstacle.type];
        claim(`obstacle ${obstacle.id}`, obstacle.gridX, obstacle.gridY, definition.width, definition.height);
    }
}

console.log('world postcard regression passed: residency plus 128 deterministic full-detail bot villages');
