import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import type {
    ProjectileLaunchPayload,
    ReplayBuildingRef,
    ReplayPresentationPoint,
    ReplayTroopRef
} from '../src/game/replay/ReplayPresentationEvents';
import {
    sampleWorldBattleProjectile,
    WorldBattlePresentationModel
} from '../src/game/replay/WorldBattlePresentationModel';
import {
    ReplayPresentationRecorder,
    replayPresentationEvent
} from '../src/game/replay/ReplayPresentationStream';

const sourcePoint: ReplayPresentationPoint = {
    gridX: 2,
    gridY: 3,
    worldX: -32,
    worldY: 66
};
const targetPoint: ReplayPresentationPoint = {
    gridX: 8,
    gridY: 9,
    worldX: -32,
    worldY: 272
};
const archer: ReplayTroopRef = {
    kind: 'troop',
    id: 'troop-archer-1',
    type: 'archer',
    owner: 'PLAYER',
    level: 2
};
const cannon: ReplayBuildingRef = {
    kind: 'building',
    id: 'building-cannon-1',
    type: 'cannon',
    owner: 'ENEMY',
    level: 3
};

function recordedCausalShot() {
    const recorder = new ReplayPresentationRecorder<{ health: number }>({
        streamId: 'attack-projectile-causality',
        maxChunks: 16,
        maxApproxBytes: 100_000,
        maxAgeMs: 10_000
    });
    recorder.recordKeyframe(0, { health: 500 });
    const projectileId = 'rp_2_cannonball';
    const launch = recorder.recordEvent(100, replayPresentationEvent('projectile.launch', {
        projectileId,
        projectile: 'cannonball',
        sourceEntity: cannon,
        targetEntity: archer,
        source: sourcePoint,
        target: targetPoint,
        level: cannon.level,
        rotation: 0,
        scale: 1,
        trajectory: {
            kind: 'homing',
            durationMs: 420,
            ease: 'Quad.easeIn',
            trackTargetId: archer.id
        }
    }));
    const impact = recorder.recordEvent(520, replayPresentationEvent('projectile.impact', {
        projectileId,
        projectile: 'cannonball',
        style: 'cannon-impact',
        at: targetPoint,
        sourceEntity: cannon,
        targetEntity: archer,
        level: cannon.level,
        radiusTiles: 0
    }));
    const damage = recorder.recordEvent(520, replayPresentationEvent('combat.damage', {
        source: cannon,
        target: archer,
        at: targetPoint,
        damageKind: 'projectile',
        amount: 70,
        healthBefore: 500,
        healthAfter: 430,
        maxHealth: 500,
        linkedPresentationEventId: launch.event.id,
        healthBar: { show: true, holdMs: 5_000, fadeMs: 600 }
    }));
    return { launch, impact, damage, chunks: recorder.snapshot() };
}

test('projectile launch, impact, and health transition form one stable causal chain', () => {
    const first = recordedCausalShot();
    const retry = recordedCausalShot();

    assert.deepEqual(first.chunks, retry.chunks,
        'same stream, sequence, and timestamps must reproduce ids and seeds byte-for-byte');
    assert.equal(first.impact.event.payload.projectileId, first.launch.event.payload.projectileId);
    assert.equal(first.damage.event.payload.linkedPresentationEventId, first.launch.event.id);
    assert.equal(first.impact.t, first.damage.t,
        'health changes in the exact authored impact bucket');
    assert.deepEqual(first.chunks.map(chunk => [chunk.sequence, chunk.t, chunk.kind]), [
        [1, 0, 'keyframe'],
        [2, 100, 'event'],
        [3, 520, 'event'],
        [4, 520, 'event']
    ]);
});

test('every visible live projectile publishes exact launch and impact metadata', () => {
    const source = readFileSync('src/game/scenes/MainScene.ts', 'utf8');
    const projectileKinds = [
        'cannonball',
        'ballista-bolt',
        'xbow-bolt',
        'mortar-shell',
        'spike-ball',
        'archer-arrow',
        'mobile-mortar-shell',
        'trebuchet-stone',
        'ornithopter-bomb',
        'necromancer-orb',
        'generic-tracer',
        'da-vinci-cannonball'
    ];
    const impactStyles = [
        'cannon-impact',
        'ballista-impact',
        'xbow-impact',
        'mortar-explosion',
        'spike-zone-impact',
        'arrow-hit',
        'mobile-mortar-explosion',
        'trebuchet-explosion',
        'ornithopter-explosion',
        'grave-orb-burst',
        'tracer-hit',
        'da-vinci-impact'
    ];

    for (const projectile of projectileKinds) {
        assert.match(source, new RegExp(`projectile: '${projectile}'`),
            `${projectile} must publish projectile.launch`);
    }
    for (const style of impactStyles) {
        assert.match(source, new RegExp(`style: '${style}'`),
            `${style} must publish projectile.impact`);
    }
    assert.equal((source.match(/recordReplayProjectileLaunch\(\{/g) ?? []).length, projectileKinds.length);
    assert.equal((source.match(/recordReplayProjectileImpact\(/g) ?? []).length, impactStyles.length + 1,
        'one helper declaration plus one impact publisher per visible projectile');

    const preservingStart = source.indexOf('private recordReplayMetadataPreservingRandom');
    const preservingEnd = source.indexOf('private recordReplayProjectileLaunch', preservingStart);
    const preservingBody = source.slice(preservingStart, preservingEnd);
    assert.match(preservingBody, /const parentRandom = this\.activeReplayPresentationRandom/);
    assert.match(preservingBody, /const parentSeed = this\.activeReplayPresentationSeed/);
    assert.match(preservingBody, /finally\s*\{[\s\S]*activeReplayPresentationRandom = parentRandom[\s\S]*activeReplayPresentationSeed = parentSeed/,
        'metadata recording must restore the parent event RNG used by the live/full-replay presenter');

    const impactHelperStart = source.indexOf('private recordReplayProjectileImpact');
    const impactHelperEnd = source.indexOf('private clearReplayWatchState', impactHelperStart);
    assert.match(source.slice(impactHelperStart, impactHelperEnd),
        /return chunk \? causality\.launchEventId : undefined/,
        'damage must link to the launch event id used to time the visible flight');
});

test('immediate tracer impact preserves the authored 160ms line lifetime', () => {
    const presentation = new WorldBattlePresentationModel();
    const tracer: ProjectileLaunchPayload = {
        projectileId: 'tracer-1',
        projectile: 'generic-tracer',
        sourceEntity: archer,
        targetEntity: cannon,
        source: sourcePoint,
        target: targetPoint,
        level: archer.level,
        rotation: 0,
        scale: 1,
        trajectory: { kind: 'instant', durationMs: 160 }
    };
    presentation.applyProjectileLaunch(tracer, 100, 11, { eventId: 'launch-tracer' });
    presentation.applyProjectileImpact({
        projectileId: tracer.projectileId,
        projectile: tracer.projectile,
        style: 'tracer-hit',
        at: targetPoint,
        sourceEntity: archer,
        targetEntity: cannon,
        level: archer.level,
        radiusTiles: 0
    }, 100, 12);

    assert.equal(presentation.projectiles.get(tracer.projectileId)?.endT, 260);
    presentation.prune(259);
    assert.equal(presentation.projectiles.has(tracer.projectileId), true,
        'same-tick damage/impact must not erase the still-visible tracer');
    presentation.prune(261);
    assert.equal(presentation.projectiles.has(tracer.projectileId), false);
});

test('homing sampling moves the authored body-surface contact with its target', () => {
    const authoredFeet: ReplayPresentationPoint = {
        gridX: 8,
        gridY: 9,
        worldX: (8 - 9) * 32,
        worldY: (8 + 9) * 16
    };
    const bodySurface: ReplayPresentationPoint = {
        ...authoredFeet,
        worldX: authoredFeet.worldX + 13,
        worldY: authoredFeet.worldY - 27
    };
    const launch: ProjectileLaunchPayload = {
        projectileId: 'homing-body-1',
        projectile: 'cannonball',
        sourceEntity: cannon,
        targetEntity: archer,
        source: sourcePoint,
        target: bodySurface,
        level: cannon.level,
        rotation: 0,
        scale: 1,
        trajectory: {
            kind: 'homing',
            durationMs: 200,
            ease: 'Linear',
            trackTargetId: archer.id
        }
    };
    const movedPose: ReplayPresentationPoint = {
        gridX: 11,
        gridY: 8,
        worldX: (11 - 8) * 32,
        worldY: (11 + 8) * 16 - 4
    };
    const presentation = new WorldBattlePresentationModel();
    presentation.applyProjectileLaunch(launch, 0, 13, { eventId: 'launch-homing-body' });
    const landed = sampleWorldBattleProjectile(
        presentation.projectiles.get(launch.projectileId)!,
        200,
        () => movedPose
    );

    assert.deepEqual(landed.point, {
        gridX: movedPose.gridX,
        gridY: movedPose.gridY,
        worldX: movedPose.worldX + 13,
        worldY: movedPose.worldY - 27
    }, 'target motion must translate the recorded surface hit, not replace it with troop feet');
});

test('no-rise parabolic metadata samples the live single quadratic Bezier', () => {
    const apexWorldY = -200;
    const launch: ProjectileLaunchPayload = {
        projectileId: 'defense-mortar-1',
        projectile: 'mortar-shell',
        sourceEntity: cannon,
        targetEntity: archer,
        source: { gridX: 0, gridY: 0, worldX: 0, worldY: -35 },
        target: { gridX: 4, gridY: 0, worldX: 256, worldY: 64 },
        level: 2,
        rotation: 0,
        scale: 1,
        trajectory: {
            kind: 'parabolic',
            durationMs: 1_000,
            apexWorldY,
            spinRadians: Math.PI * 4
        }
    };
    const presentation = new WorldBattlePresentationModel();
    presentation.applyProjectileLaunch(launch, 0, 17, { eventId: 'launch-defense-mortar' });
    const quarter = sampleWorldBattleProjectile(
        presentation.projectiles.get(launch.projectileId)!,
        250,
        () => launch.target
    );
    const expectedY = 0.75 ** 2 * launch.source.worldY
        + 2 * 0.75 * 0.25 * apexWorldY
        + 0.25 ** 2 * launch.target.worldY;

    assert.equal(quarter.point.worldX, 64);
    assert.equal(quarter.point.worldY, expectedY);
});

test('live replay metadata mirrors tracer lifetime and defense Bezier paths', () => {
    const source = readFileSync('src/game/scenes/MainScene.ts', 'utf8');
    const slice = (start: string, end: string) => {
        const from = source.indexOf(start);
        const to = source.indexOf(end, from + start.length);
        assert.notEqual(from, -1, `missing ${start}`);
        assert.notEqual(to, -1, `missing ${end}`);
        return source.slice(from, to);
    };
    const tracer = slice('private showGenericRangedAttack', 'private showArcherProjectile');
    const mortar = slice('private shootMortarAt', 'private createMortarExplosion');
    const spike = slice('private shootSpikeLauncherAt', 'private createSpikeZone');
    const trebuchet = slice('private showTrebuchetShot', 'private showOrnithopterBomb');

    assert.match(tracer,
        /projectile: 'generic-tracer'[\s\S]*?trajectory: \{ kind: 'instant', durationMs: 160 \}/);
    assert.doesNotMatch(mortar, /projectile: 'mortar-shell'[\s\S]*?riseMs:/,
        'defense mortar uses the live single quadratic Bezier');
    assert.doesNotMatch(spike, /projectile: 'spike-ball'[\s\S]*?riseMs:/,
        'spike ball uses the live single quadratic Bezier');
    assert.match(trebuchet, /projectile: 'trebuchet-stone'[\s\S]*?riseMs: flightMs \/ 2/,
        'two-tween troop lob retains its authored split trajectory');
});
