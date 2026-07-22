import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ReplayFrameSnapshot } from '../src/game/backend/GameBackend.ts';
import type { ReplayTimelineSample } from '../src/game/replay/ReplayTimeline.ts';
import type {
    ProjectileLaunchPayload,
    ReplayBuildingRef,
    ReplayPresentationPoint,
    ReplayTroopRef
} from '../src/game/replay/ReplayPresentationEvents.ts';
import {
    WorldBattlePlaybackModel,
    createReplaySequenceCursor,
    observeReplaySequences,
    presentationOverlapsReplayJoin,
    sampleWorldBattleTroop,
    terminalReplayGapFrom,
    worldBattlePreRollBaseline,
    worldBattleTroopPoseAt
} from '../src/game/replay/WorldBattlePlaybackModel.ts';
import {
    WorldBattlePresentationModel,
    sampleWorldBattleProjectile,
    worldBattleProjectileEndT
} from '../src/game/replay/WorldBattlePresentationModel.ts';

const frame = (
    t: number,
    buildingHealth: number,
    troopX: number,
    troopHealth = 100
): ReplayFrameSnapshot => ({
    t,
    destruction: buildingHealth <= 0 ? 100 : 0,
    goldLooted: 0,
    buildings: [{ id: 'hall', health: buildingHealth, isDestroyed: buildingHealth <= 0 }],
    troops: [{
        id: 'troop',
        type: 'warrior',
        level: 1,
        owner: 'PLAYER',
        gridX: troopX,
        gridY: 4,
        health: troopHealth,
        maxHealth: 100,
        facingAngle: 0
    }]
});

test('world postcard interpolates pose but never future health', () => {
    const first = frame(0, 100, 2, 100);
    const second = frame(1_000, 40, 8, 35);
    const model = new WorldBattlePlaybackModel(new Map([['hall', 100]]));
    model.applyFrame(first);

    const sample: ReplayTimelineSample<ReplayFrameSnapshot> = {
        t: 500,
        previous: { t: 0, rawT: 0, sequence: 1, terminal: false, frame: first },
        next: { t: 1_000, rawT: 1_000, sequence: 4, terminal: false, frame: second },
        alpha: 0.5
    };
    const troop = sampleWorldBattleTroop(model.troops.get('troop')!, sample);

    assert.equal(troop.gridX, 5, 'position is smoothed between keyframes');
    assert.equal(troop.health, 100, 'troop health remains on the current authoritative step');
    assert.equal(model.buildings.get('hall')?.health, 100,
        'building health does not leak from the future keyframe');

    model.applyFrame(second);
    assert.equal(model.troops.get('troop')?.health, 35);
    assert.equal(model.buildings.get('hall')?.health, 40);
});

test('rotating-defense aim survives late joins and legacy correction frames', () => {
    const model = new WorldBattlePlaybackModel(new Map([['hall', 100]]));
    const initial = frame(0, 100, 2);
    initial.buildings[0].ballistaAngle = Math.PI / 3;
    model.applyFrame(initial);
    assert.equal(model.buildings.get('hall')?.ballistaAngle, Math.PI / 3);

    model.applyFrame(frame(125, 90, 2));
    assert.equal(model.buildings.get('hall')?.ballistaAngle, Math.PI / 3,
        'an old frame without aim must preserve the last committed heading');

    const correction = frame(250, 80, 2);
    correction.buildings[0].ballistaAngle = -Math.PI / 2;
    model.applyFrame(correction);
    assert.equal(model.buildings.get('hall')?.ballistaAngle, -Math.PI / 2);

    const playbackSource = readFileSync('src/game/replay/WorldBattlePlayback.ts', 'utf8');
    assert.match(playbackSource,
        /private applyReplayFrame[\s\S]*?snapshot\.ballistaAngle[\s\S]*?meta\.ballistaAngle/,
        'nearby playback must forward correction aim into the baked building renderer');
});

test('damage and collapse remain two exact replay events', () => {
    const model = new WorldBattlePlaybackModel(new Map([['hall', 100]]));
    model.applyFrame(frame(0, 100, 2));

    const damaged = model.damageEntity('building', 'hall', 0, 100);
    assert.equal(damaged.destroyedChanged, false);
    assert.equal(model.buildings.get('hall')?.health, 0);
    assert.equal(model.buildings.get('hall')?.isDestroyed, false,
        'zero-health hit alone must not pre-empt the authored collapse');
    assert.equal(model.destroyedBuildingIds.has('hall'), false);

    const collapsed = model.destroyBuilding('hall');
    assert.deepEqual(collapsed.newlyDestroyedBuildingIds, ['hall']);
    assert.equal(model.destroyedBuildingIds.has('hall'), true);
});

test('a troop spawned between keyframes starts at its authored point without a jump', () => {
    const before = frame(0, 100, 0);
    before.troops = [];
    const after = frame(500, 100, 8);
    const model = new WorldBattlePlaybackModel(new Map([['hall', 100]]));
    model.applyFrame(before);
    model.spawnTroop({
        ...after.troops[0],
        gridX: 2
    }, 100);
    const sample: ReplayTimelineSample<ReplayFrameSnapshot> = {
        t: 100,
        previous: { t: 0, rawT: 0, sequence: 1, terminal: false, frame: before },
        next: { t: 500, rawT: 500, sequence: 3, terminal: false, frame: after },
        alpha: 0.2
    };

    const atSpawn = sampleWorldBattleTroop(model.troops.get('troop')!, sample);
    assert.equal(atSpawn.gridX, 2);
    const later = sampleWorldBattleTroop(model.troops.get('troop')!, { ...sample, t: 300, alpha: 0.6 });
    assert.equal(later.gridX, 5, 'movement interpolates from spawn time, not the older keyframe');
});

test('complete keyframes remove missing troops and restore corrected buildings', () => {
    const model = new WorldBattlePlaybackModel(new Map([['hall', 100]]));
    model.applyFrame(frame(0, 0, 2));
    assert.equal(model.destroyedBuildingIds.has('hall'), true);

    const correction = frame(1_000, 75, 4);
    correction.troops = [];
    const transition = model.applyFrame(correction);
    assert.deepEqual(transition.restoredBuildingIds, ['hall']);
    assert.deepEqual(transition.removedTroopIds, ['troop']);
    assert.equal(model.troops.size, 0);
});

test('incremental replay cursor acknowledges only contiguous sequences', () => {
    let cursor = createReplaySequenceCursor();
    cursor = observeReplaySequences(cursor, [1, 3, 3]);
    assert.equal(cursor.contiguous, 1);
    assert.deepEqual([...cursor.pending], [3]);

    cursor = observeReplaySequences(cursor, [2]);
    assert.equal(cursor.contiguous, 3);
    assert.deepEqual([...cursor.pending], []);

    cursor = observeReplaySequences(cursor, [6, 5]);
    assert.equal(cursor.contiguous, 3, 'a missing sequence remains requestable');
    cursor = observeReplaySequences(cursor, [4]);
    assert.equal(cursor.contiguous, 6);
});

test('initial terminal-only join preserves the authoritative correction across a storage gap', () => {
    const baseline = { sequence: 4, t: 0, kind: 'keyframe' as const, frame: frame(0, 100, 2) };
    const terminal = {
        sequence: 9,
        t: 2_000,
        kind: 'keyframe' as const,
        terminal: true,
        frame: frame(2_000, 0, 4)
    };
    assert.equal(terminalReplayGapFrom([terminal, baseline], baseline.sequence)?.sequence, 9);
    assert.equal(terminalReplayGapFrom([
        baseline,
        { ...terminal, sequence: 5 }
    ], baseline.sequence), null, 'a contiguous terminal keyframe never authorizes a skip');
});

test('Siege Tower parking is a persistent authored pose, not a one-cycle attack frame', () => {
    const model = new WorldBattlePlaybackModel();
    model.spawnTroop({
        id: 'tower', type: 'siegetower', level: 1, owner: 'PLAYER',
        gridX: 3, gridY: 3, health: 100, maxHealth: 100, facingAngle: 0
    });
    model.markTroopAttack('tower', 100, 'siege-tower-park', Math.PI / 2);
    const tower = model.troops.get('tower')!;
    assert.equal(worldBattleTroopPoseAt(tower, 450).parked01, 0.5);
    assert.equal(worldBattleTroopPoseAt(tower, 10_000).parked01, 1,
        'the deployed ramp must remain in its deactivated pose');
    assert.equal(tower.facingAngle, Math.PI / 2);

    const lateJoin = frame(20_000, 100, 4);
    lateJoin.troops[0] = {
        ...lateJoin.troops[0],
        id: 'tower',
        type: 'siegetower',
        parked01: 1
    };
    const corrected = new WorldBattlePlaybackModel();
    corrected.applyFrame(lateJoin);
    assert.equal(worldBattleTroopPoseAt(corrected.troops.get('tower')!, 20_000).parked01, 1,
        'a keyframe alone restores persistent parking after an arbitrarily late join');
});

test('late join reconstructs only presentation effects that still overlap it', () => {
    const baseline = worldBattlePreRollBaseline(
        [{ t: 0 }, { t: 500 }, { t: 1_000 }, { t: 1_500 }],
        1_500,
        900
    );
    assert.equal(baseline.t, 500,
        'pre-roll starts before a 900ms flight that crosses the join bracket');
    assert.equal(presentationOverlapsReplayJoin(100, 1_000, 900), true,
        'a pre-join launch with a post-join impact must remain visible');
    assert.equal(presentationOverlapsReplayJoin(100, 800, 900), false,
        'fully expired catch-up FX stay suppressed');
});

test('world battle visuals retain the canonical isometric depth contract', () => {
    const playbackSource = readFileSync('src/game/replay/WorldBattlePlayback.ts', 'utf8');
    assert.match(playbackSource,
        /carrier\.setDepth\(depthForBuilding\(meta\.gridX, meta\.gridY, meta\.type\)\)/,
        'surviving roofs must be individual carriers at canonical building depth');
    assert.match(playbackSource,
        /carrier\.setDepth\(depthForTroop\(sampled\.gridX, sampled\.gridY, type\)\)/,
        'moving troops must use the same foot-anchor depth as full battle');
    assert.match(playbackSource,
        /this\.groundOverlay\.setDepth\(depthForGroundDecal\('crater'\)\)/,
        'wreck scars belong to the absolute ground-decal class');
    assert.match(playbackSource,
        /this\.battleLayer = scene\.add\.layer\(\)[\s\S]*?this\.battleLayer\.add\(\[this\.groundOverlay, this\.healthOverlay\]\)/,
        'postcard entities need an isolated child display list so exact local depths cannot escape the plot band');
    assert.match(playbackSource,
        /this\.healthOverlay\.setDepth\(30_000\)[\s\S]*?depthForProjectile\(sample\.ground\.gridX, sample\.ground\.gridY\)/,
        'health UI stays separate from canonically depth-sorted projectile carriers');
    assert.match(playbackSource,
        /const troop = this\.sampledTroops\.get\(entity\.id\) \?\? this\.model\.troops\.get\(entity\.id\)/,
        'tracking beams and homing shots resolve the same once-per-tick pose as the sprite');
    assert.doesNotMatch(playbackSource,
        /building\.health >= building\.maxHealth/,
        'healthy defending buildings keep visible health bars');
    assert.match(playbackSource,
        /await this\.ensureReplayAssets\(replay\)[\s\S]*?this\.installInitialReplay\(replay\)/,
        'the first battle frame waits for its referenced sprite atlases');
    assert.match(playbackSource, /SpriteBank\.syncTroopDeath\(/);
    assert.match(playbackSource, /SpriteBank\.syncWreck\(/);
    assert.doesNotMatch(playbackSource, /setDepth\(29_000\)|this\.overlay/,
        'no battle FX surface may share a near-top depth; health bars are the only topmost child');
    for (const carrierKey of [
        'state:tesla-ring:', 'state:tesla-link:', 'state:freeze:',
        'state:prism:', 'state:dragon:'
    ]) {
        assert.match(playbackSource, new RegExp(carrierKey),
            `${carrierKey} must own an independent, canonically sorted carrier`);
    }
    assert.match(playbackSource,
        /buildingDressingDepth\([\s\S]*?depthForBuilding\(meta\.gridX, meta\.gridY, meta\.type\) \+ bias/,
        'building-anchored Tesla/freeze dressing rides the building occluder band');
    assert.match(playbackSource,
        /state:prism:[\s\S]*?depthForProjectile\([\s\S]*?state:dragon:[\s\S]*?depthForProjectile\(/,
        'beams and Dragon rockets use current ground-track projectile depth');
    assert.doesNotMatch(playbackSource, /placement\.baseDepth \+ 2/,
        'the former row-fraction shortcut made every troop paint above the flattened roofs');

    const spriteBankSource = readFileSync('src/game/render/SpriteBank.ts', 'utf8');
    assert.match(spriteBankSource,
        /carrier\.displayList && img\.displayList !== carrier\.displayList[\s\S]*?carrier\.displayList\.add\(img\)/,
        'a baked shadow sprite must inherit its carrier Layer for child depth sorting');
});

test('nearby-world deaths and collapses keep their authored visual identities', () => {
    const source = readFileSync('src/game/replay/WorldBattlePlayback.ts', 'utf8');
    assert.doesNotMatch(source,
        /private startTroopDeath[\s\S]{0,240}if \(!isLargeTroopDeathType\([^)]*\)\) return/,
        'common troop deaths must not disappear before presentation');
    for (const style of [
        'standard-poof', 'wall-breaker-detonation',
        'clockwork-beetle-detonation', 'phalanx-split'
    ]) {
        assert.match(source, new RegExp(`case '${style}'`),
            `${style} needs a deterministic, style-specific draw path`);
    }
    assert.match(source,
        /SpriteBank\.syncTroopDeath\([\s\S]*?drawStandardTroopPoof\(/,
        'baked colossal collapses and frequent compact poofs must both remain available');
    assert.match(source,
        /startBuildingCollapse\([\s\S]*?style === 'tesla-defense'[\s\S]*?style === 'town-hall'[\s\S]*?style === 'defense'/,
        'building collapse cues must distinguish electrical, marquee, defense, and ordinary structures');
    assert.match(source,
        /handleTransition\(this\.model\.destroyBuilding[\s\S]*?SpriteBank\.syncWreck\(/,
        'authored collapse cues must still settle into the baked wreck path');
    assert.match(source, /Nearby battles are ambient world activity[\s\S]*sound/,
        'visual parity must not introduce ambient battle sound or camera shake');
});

const battlePoint = (gridX: number, gridY: number): ReplayPresentationPoint => ({
    gridX,
    gridY,
    worldX: (gridX - gridY) * 32,
    worldY: (gridX + gridY) * 16
});

const defenseRef: ReplayBuildingRef = {
    kind: 'building', id: 'defense', type: 'tesla', owner: 'ENEMY', level: 2
};
const troopRef: ReplayTroopRef = {
    kind: 'troop', id: 'troop', type: 'warrior', owner: 'PLAYER', level: 1
};

test('projectile sampler preserves delay, authored apex, easing, spin, and homing target', () => {
    const source = battlePoint(0, 0);
    const target = battlePoint(10, 0);
    const base: ProjectileLaunchPayload = {
        projectileId: 'stone',
        projectile: 'trebuchet-stone',
        sourceEntity: troopRef,
        targetEntity: defenseRef,
        source,
        target,
        level: 2,
        rotation: 0.25,
        scale: 1,
        trajectory: {
            kind: 'parabolic',
            durationMs: 900,
            launchDelayMs: 150,
            riseMs: 450,
            apexWorldY: -200,
            spinRadians: Math.PI * 4
        }
    };
    const presentation = new WorldBattlePresentationModel();
    presentation.applyProjectileLaunch(base, 100, 7, { eventId: 'launch-stone' });
    const state = presentation.projectiles.get('stone')!;
    const resolve = () => target;
    assert.equal(worldBattleProjectileEndT(base, 100), 1_150);
    assert.deepEqual(sampleWorldBattleProjectile(state, 249, resolve).point, source,
        'launch delay holds the munition at its exact authored source');
    const apex = sampleWorldBattleProjectile(state, 700, resolve);
    assert.equal(apex.point.worldY, -200);
    assert.equal(apex.point.worldX, (source.worldX + target.worldX) / 2);
    assert.equal(apex.rotation, 0.25 + Math.PI * 2);
    const landed = sampleWorldBattleProjectile(state, 1_150, resolve);
    assert.equal(landed.point.worldX, target.worldX);
    assert.equal(landed.point.worldY, target.worldY);

    const homing: ProjectileLaunchPayload = {
        ...base,
        projectileId: 'ball',
        projectile: 'cannonball',
        trajectory: {
            kind: 'homing', durationMs: 200, ease: 'Quad.easeIn', trackTargetId: troopRef.id
        }
    };
    presentation.applyProjectileLaunch(homing, 0, 9, { eventId: 'launch-ball' });
    const movedTarget = battlePoint(20, 0);
    const midway = sampleWorldBattleProjectile(
        presentation.projectiles.get('ball')!,
        100,
        () => movedTarget
    );
    assert.equal(midway.progress, 0.5);
    assert.equal(midway.point.worldX, movedTarget.worldX * 0.25,
        'Quad easing follows the cached live target instead of the stale launch point');
});

test('explicit launch suppresses its synthetic fallback and impact removes the carrier state exactly', () => {
    const presentation = new WorldBattlePresentationModel();
    const payload: ProjectileLaunchPayload = {
        projectileId: 'fallback:attack',
        projectile: 'archer-arrow',
        sourceEntity: troopRef,
        targetEntity: defenseRef,
        source: battlePoint(1, 1),
        target: battlePoint(6, 5),
        level: 1,
        rotation: 0,
        scale: 1,
        trajectory: { kind: 'linear', durationMs: 200, ease: 'Linear' }
    };
    presentation.applyProjectileLaunch(payload, 1_000, 1, {
        eventId: 'attack', fallback: true
    });
    presentation.applyProjectileLaunch({ ...payload, projectileId: 'exact-arrow' }, 1_000, 2, {
        eventId: 'launch-arrow'
    });
    assert.deepEqual([...presentation.projectiles.keys()], ['exact-arrow']);
    presentation.applyProjectileImpact({
        projectileId: 'exact-arrow',
        projectile: 'archer-arrow',
        style: 'arrow-hit',
        at: battlePoint(6, 5),
        sourceEntity: troopRef,
        targetEntity: defenseRef,
        level: 1,
        radiusTiles: 0
    }, 1_200, 3);
    assert.equal(presentation.projectiles.size, 0,
        'impact dispatch removes the rigid projectile before the same render pass');
    assert.equal(presentation.hasImpactForLaunch('launch-arrow', 1_200), true,
        'linked damage can suppress the duplicate fallback impact pulse');
});

test('stateful postcard presentation reconstructs Tesla, freeze, Prism, and Spike lifetimes', () => {
    const presentation = new WorldBattlePresentationModel();
    presentation.applyDefenseCharge({
        defense: defenseRef,
        target: troopRef,
        weapon: 'tesla',
        phase: 'start',
        chargeMs: 800,
        chargedVisualMs: 350,
        facingAngle: 0
    }, 1_000, 11);
    assert.equal(presentation.teslaCharges.get('defense')?.phase, 'charging');
    presentation.applyDefenseCharge({
        defense: defenseRef,
        target: troopRef,
        weapon: 'tesla',
        phase: 'complete',
        chargeMs: 800,
        chargedVisualMs: 350,
        facingAngle: 0
    }, 1_800, 11);
    assert.equal(presentation.teslaCharges.get('defense')?.endT, 2_150);

    const prism = { ...defenseRef, type: 'prism' as const };
    presentation.applyDefenseFire({
        defense: prism,
        target: troopRef,
        weapon: 'prism',
        source: battlePoint(4, 4),
        targetPoint: battlePoint(7, 6),
        facingAngle: 0,
        damage: 10,
        fireRateMs: 100,
        windupMs: 0
    }, 'prism-fire', 2_000, 22, 2_100);
    assert.equal(presentation.prismBeams.get('defense')?.endT, 2_250,
        'two missed ticks are tolerated without leaving a permanent beam');

    const spike = { ...defenseRef, type: 'spike_launcher' as const, level: 3 };
    presentation.applyDefenseFire({
        defense: spike,
        target: troopRef,
        weapon: 'spike-launcher',
        source: battlePoint(3, 3),
        targetPoint: battlePoint(8, 7),
        facingAngle: 0,
        damage: 38,
        fireRateMs: 2_000,
        windupMs: 150
    }, 'spike-fire', 2_000, 33, 2_900);
    assert.deepEqual(
        [...presentation.spikeZones.values()].map(zone => [zone.startT, zone.endT]),
        [[2_900, 7_700]],
        'the caltrop field starts at impact, not launch, and survives its exact authored duration'
    );

    const frozen = { ...defenseRef, type: 'cannon' as const };
    presentation.applyStatus({
        status: 'frozen',
        phase: 'apply',
        source: troopRef,
        target: frozen,
        at: battlePoint(5, 5),
        durationMs: 4_000,
        untilT: 7_000
    }, 3_000, 44);
    assert.equal(presentation.frozenBuildings.get('defense')?.endT, 7_000);
    presentation.prune(8_201);
    assert.equal(presentation.frozenBuildings.size, 0);
    assert.equal(presentation.spikeZones.size, 0);
});

test('ability reconstruction is deterministic for chains and every Dragon pod', () => {
    const resolve = (entity: ReplayBuildingRef | ReplayTroopRef) => entity.kind === 'building'
        ? battlePoint(6, 6)
        : battlePoint(9, 8);
    const make = () => {
        const presentation = new WorldBattlePresentationModel();
        presentation.applyAbility({
            ability: 'storm-chain',
            actor: { ...troopRef, type: 'stormmage' },
            at: battlePoint(2, 2),
            targets: [
                { ...defenseRef, type: 'cannon' },
                { ...defenseRef, id: 'defense-2', type: 'ballista' }
            ],
            hopDelayMs: 100,
            damageFalloff: 0.8
        }, 'chain', 1_000, 77, resolve);
        presentation.applyAbility({
            ability: 'dragons-breath-salvo',
            actor: { ...defenseRef, type: 'dragons_breath' },
            at: battlePoint(4, 4),
            targets: [troopRef],
            salvoSize: 4,
            staggerMs: 50
        }, 'salvo', 2_000, 88, resolve);
        return presentation;
    };
    const first = make();
    const second = make();
    assert.equal(first.lightning.length, 2);
    assert.deepEqual(first.lightning.map(segment => segment.startT), [1_000, 1_100]);
    assert.equal(first.dragonRockets.length, 4);
    assert.deepEqual(first.dragonRockets, second.dragonRockets,
        'event seed and event time fully determine every pod path/timing');
});

test('WorldBattlePlayback exhaustively handles the replay presentation union', () => {
    const source = readFileSync('src/game/replay/WorldBattlePlayback.ts', 'utf8');
    for (const eventType of [
        'troop.spawn', 'combat.attack', 'defense.charge', 'defense.fire',
        'projectile.launch', 'projectile.impact', 'combat.damage', 'combat.heal',
        'entity.death', 'building.destroy', 'ability', 'status', 'fx', 'sound'
    ]) {
        assert.match(source, new RegExp(`case '${eventType.replace('.', '\\.')}'`));
    }
    assert.match(source, /default:\s*assertNeverReplayPresentationEvent\(event\)/,
        'a future top-level event variant must fail typechecking instead of silently disappearing');
    assert.match(source, /Nearby battles are ambient world activity[\s\S]*sound/,
        'the one intentional fidelity exception (ambient sound) must stay documented');
});
