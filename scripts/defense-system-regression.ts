import assert from 'node:assert/strict';
import { getBuildingStats } from '../src/game/config/GameDefinitions';
import {
    DEFENSE_BEHAVIOR_CATALOG,
    type ActiveDefenseType
} from '../src/game/systems/DefenseBehaviorCatalog';
import {
    DefenseSystem,
    type DefenseFireHandler
} from '../src/game/systems/DefenseSystem';
import type { PlacedBuilding, Troop } from '../src/game/types/GameTypes';

interface FireEvent {
    effect: ActiveDefenseType;
    defenseId: string;
    targetId: string;
    time: number;
}

function defense(type: ActiveDefenseType, id = type): PlacedBuilding {
    const stats = getBuildingStats(type, 1);
    return {
        id,
        type,
        level: 1,
        gridX: 0,
        gridY: 0,
        health: stats.maxHealth,
        maxHealth: stats.maxHealth,
        owner: 'ENEMY'
    } as unknown as PlacedBuilding;
}

function troop(id: string, gridX: number, gridY: number): Troop {
    return {
        id,
        type: 'warrior',
        level: 1,
        gridX,
        gridY,
        health: 100,
        maxHealth: 100,
        owner: 'PLAYER'
    } as unknown as Troop;
}

function harness(): {
    system: DefenseSystem;
    fires: FireEvent[];
    prismCleanups: string[];
} {
    const fires: FireEvent[] = [];
    const prismCleanups: string[] = [];
    const handler = (effect: ActiveDefenseType): DefenseFireHandler =>
        (source, target, time) => fires.push({
            effect,
            defenseId: source.id,
            targetId: target.id,
            time
        });

    const system = new DefenseSystem({
        fire: {
            cannon: handler('cannon'),
            ballista: handler('ballista'),
            xbow: handler('xbow'),
            mortar: handler('mortar'),
            tesla: handler('tesla'),
            prism: handler('prism'),
            dragons_breath: handler('dragons_breath'),
            spike_launcher: handler('spike_launcher')
        },
        idle: {
            cleanupPrismLaser: source => prismCleanups.push(source.id)
        }
    });
    return { system, fires, prismCleanups };
}

function lastFire(fires: FireEvent[]): FireEvent {
    const event = fires.at(-1);
    assert(event, 'expected a defense to fire');
    return event;
}

assert.deepEqual(
    Object.keys(DEFENSE_BEHAVIOR_CATALOG).sort(),
    ['ballista', 'cannon', 'dragons_breath', 'mortar', 'prism', 'spike_launcher', 'tesla', 'xbow'],
    'every active defense must have an explicit behavior policy'
);

// Cooldown-start defenses wait one complete interval, retain a valid lock,
// and reacquire only after that lock leaves their legal range.
{
    const { system, fires } = harness();
    const cannon = defense('cannon');
    const first = troop('first', 2.5, 0.5);
    const challenger = troop('challenger', 4.5, 0.5);

    system.update(1_000, [cannon], [first, challenger]);
    system.update(3_399, [cannon], [first, challenger]);
    assert.equal(fires.length, 0, 'cannon fired before its initial cooldown');

    system.update(3_400, [cannon], [first, challenger]);
    assert.equal(lastFire(fires).targetId, first.id);
    assert.equal(cannon.lockedTargetId, first.id);

    challenger.gridX = 1.5;
    system.update(5_800, [cannon], [first, challenger]);
    assert.equal(lastFire(fires).targetId, first.id, 'cannon abandoned a valid sticky lock');

    first.gridX = 20;
    system.update(8_200, [cannon], [first, challenger]);
    assert.equal(lastFire(fires).targetId, challenger.id, 'cannon did not replace an invalid lock');
    assert.equal(cannon.lockedTargetId, challenger.id);
}

// Nearest-target defenses do not retain locks and respect their dead zone.
{
    const { system, fires } = harness();
    const mortar = defense('mortar');
    const insideMinimum = troop('inside-minimum', 3, 1);
    const firstInBand = troop('first-in-band', 6, 1);
    const laterNearest = troop('later-nearest', 8, 1);

    system.update(1_000, [mortar], [insideMinimum, firstInBand, laterNearest]);
    system.update(4_900, [mortar], [insideMinimum, firstInBand, laterNearest]);
    assert.equal(lastFire(fires).targetId, firstInBand.id, 'mortar selected a troop inside minRange');
    assert.equal(mortar.lockedTargetId, undefined);

    firstInBand.gridX = 9;
    laterNearest.gridX = 5;
    system.update(8_800, [mortar], [insideMinimum, firstInBand, laterNearest]);
    assert.equal(lastFire(fires).targetId, laterNearest.id, 'nearest policy retained the previous target');
    assert.equal(mortar.lockedTargetId, undefined);
}

// Prism acts on its first tick and tears down its continuous visual when no
// legal target remains.
{
    const { system, fires, prismCleanups } = harness();
    const prism = defense('prism');
    const idlePrism = defense('prism', 'idle-prism');
    const target = troop('ready-target', 2, 0.5);

    system.update(1_000, [prism], [target]);
    assert.deepEqual(
        fires.map(event => event.effect),
        ['prism'],
        'prism did not fire on its first tick'
    );

    system.update(1_000, [idlePrism], []);
    assert.deepEqual(prismCleanups, [idlePrism.id]);

    target.health = 0;
    system.update(1_100, [prism], [target]);
    assert.deepEqual(prismCleanups, [idlePrism.id, prism.id], 'idle Prism beam was not cleaned up');
}

// Tesla waits for its normal cooldown, charges for exactly 800ms, and keeps
// its charged renderer state through 400ms (clearing only after that point).
{
    const { system, fires } = harness();
    const tesla = defense('tesla');
    const target = troop('tesla-target', 2, 0.5);

    system.update(1_000, [tesla], [target]);
    system.update(3_399, [tesla], [target]);
    assert.equal(tesla.teslaCharging, undefined);

    system.update(3_400, [tesla], [target]);
    assert.equal(tesla.teslaCharging, true);
    assert.equal(tesla.teslaChargeStart, 3_400);

    system.update(4_199, [tesla], [target]);
    assert.equal(fires.length, 0, 'Tesla fired before its 800ms charge completed');
    system.update(4_200, [tesla], [target]);
    assert.equal(lastFire(fires).targetId, target.id);
    assert.equal(lastFire(fires).time, 4_200);
    assert.equal(tesla.teslaCharging, false);
    assert.equal(tesla.teslaCharged, true);

    system.update(4_600, [tesla], [target]);
    assert.equal(tesla.teslaCharged, true, 'Tesla charged state cleared at the inclusive boundary');
    system.update(4_601, [tesla], [target]);
    assert.equal(tesla.teslaCharged, false);
}

// A charge cancels immediately when its locked target becomes invalid. The
// replacement is deliberately acquired on the following tick, not mid-cancel.
{
    const { system, fires } = harness();
    const tesla = defense('tesla', 'cancel-tesla');
    const abandoned = troop('abandoned', 2, 0.5);
    const replacement = troop('replacement', 4, 0.5);

    system.update(1_000, [tesla], [abandoned, replacement]);
    system.update(3_400, [tesla], [abandoned, replacement]);
    abandoned.gridX = 20;
    system.update(3_600, [tesla], [abandoned, replacement]);
    assert.equal(tesla.teslaCharging, false);
    assert.equal(tesla.teslaChargeTarget, undefined);
    assert.equal(tesla.lockedTargetId, undefined);
    assert.equal(fires.length, 0);

    system.update(3_601, [tesla], [abandoned, replacement]);
    assert.equal(tesla.teslaCharging, true);
    assert.equal(tesla.teslaChargeTarget?.id, replacement.id);
    system.update(4_401, [tesla], [abandoned, replacement]);
    assert.equal(lastFire(fires).targetId, replacement.id);
}

// Construction sites are entirely offline: no state initialization, firing,
// target locks, charge transitions, or continuous-effect cleanup.
{
    const { system, fires, prismCleanups } = harness();
    const cannon = defense('cannon', 'upgrading-cannon');
    const prism = defense('prism', 'upgrading-prism');
    const target = troop('offline-target', 2, 0.5);
    cannon.upgradingTo = 2;
    prism.upgradingTo = 2;

    system.update(50_000, [cannon, prism], [target]);
    assert.equal(cannon.lastFireTime, undefined);
    assert.equal(prism.lastFireTime, undefined);
    assert.equal(fires.length, 0);
    assert.equal(prismCleanups.length, 0);
}

console.log('defense system regressions passed');
