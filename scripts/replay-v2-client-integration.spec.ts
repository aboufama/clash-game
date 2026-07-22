import assert from 'node:assert/strict';
import test from 'node:test';
import type {
    ReplayBuildingRef,
    ReplayPresentationPoint,
    ReplayTroopRef
} from '../src/game/replay/ReplayPresentationEvents.ts';
import {
    ReplayPresentationDispatcher,
    ReplayPresentationRecorder,
    replayPresentationEvent
} from '../src/game/replay/ReplayPresentationStream.ts';
import { ReplayTimeline } from '../src/game/replay/ReplayTimeline.ts';
import {
    REPLAY_CORRECTION_FRAME_BUDGET,
    REPLAY_CORRECTION_INTERVAL_MS,
    REPLAY_DEFAULT_MAX_DURATION_MS,
    replayCorrectionFrameCount
} from '../src/game/replay/ReplayTypes.ts';

interface ClientReplayFrame {
    t: number;
    buildingHealth: number;
    troopIds: string[];
}

const troop: ReplayTroopRef = {
    kind: 'troop',
    id: 'troop-1',
    type: 'warrior',
    owner: 'PLAYER',
    level: 1
};

const building: ReplayBuildingRef = {
    kind: 'building',
    id: 'building-1',
    type: 'town_hall',
    owner: 'ENEMY',
    level: 1
};

const troopPoint: ReplayPresentationPoint = {
    gridX: 4,
    gridY: 5,
    worldX: -32,
    worldY: 144
};

const buildingPoint: ReplayPresentationPoint = {
    gridX: 10,
    gridY: 10,
    worldX: 0,
    worldY: 320
};

test('125 ms correction sampling is 24 Hz aligned and fits the bounded replay stores', () => {
    assert.equal(REPLAY_CORRECTION_INTERVAL_MS, 125);
    assert.equal(REPLAY_CORRECTION_INTERVAL_MS / (1000 / 24), 3);
    assert.equal(replayCorrectionFrameCount(REPLAY_DEFAULT_MAX_DURATION_MS), 7_201);
    assert.ok(replayCorrectionFrameCount(REPLAY_DEFAULT_MAX_DURATION_MS) <= REPLAY_CORRECTION_FRAME_BUDGET);
    assert.ok(REPLAY_CORRECTION_FRAME_BUDGET < 16_384, 'server count budget remains below the client recorder ceiling');
});

test('canonical replay-v2 recorder, timeline, and dispatcher remain one ordered live pipeline', () => {
    const recorder = new ReplayPresentationRecorder<ClientReplayFrame>({
        streamId: 'attack-client-integration',
        maxChunks: 32,
        maxApproxBytes: 250_000,
        maxAgeMs: 20_000
    });

    const baseline = recorder.recordKeyframe(0, {
        t: 0,
        buildingHealth: 100,
        troopIds: []
    });
    const deploy = recorder.recordEvent(100, replayPresentationEvent('troop.spawn', {
        troop,
        at: troopPoint,
        reason: 'deployment',
        facingAngle: 0,
        maxHealth: 100,
        attackDelayMs: 900,
        firstAttackDelayMs: 0,
        landingMs: 200,
        playDeploySound: true
    }));
    const movingKeyframe = recorder.recordKeyframe(500, {
        t: 500,
        buildingHealth: 100,
        troopIds: [troop.id]
    });
    const attack = recorder.recordEvent(600, replayPresentationEvent('combat.attack', {
        actor: troop,
        target: building,
        at: troopPoint,
        targetPoint: buildingPoint,
        style: 'melee-punch',
        phase: 'impact',
        facingAngle: 0,
        attackDelayMs: 900,
        phaseDurationMs: 120
    }));
    const damage = recorder.recordEvent(800, replayPresentationEvent('combat.damage', {
        source: troop,
        target: building,
        at: buildingPoint,
        damageKind: 'melee',
        amount: 25,
        healthBefore: 100,
        healthAfter: 75,
        maxHealth: 100,
        linkedPresentationEventId: attack.event.id,
        healthBar: { show: true, holdMs: 5000, fadeMs: 600 }
    }));
    const correctionOne = recorder.recordKeyframe(1500, {
        t: 1500,
        buildingHealth: 75,
        troopIds: [troop.id]
    });
    const correctionTwo = recorder.recordKeyframe(3500, {
        t: 3500,
        buildingHealth: 75,
        troopIds: [troop.id]
    });
    const terminal = recorder.recordKeyframe(5500, {
        t: 5500,
        buildingHealth: 75,
        troopIds: [troop.id]
    }, true);

    assert.deepEqual(
        [baseline, deploy, movingKeyframe, attack, damage, correctionOne, correctionTwo, terminal]
            .map(chunk => [chunk.sequence, chunk.t, chunk.kind]),
        [
            [1, 0, 'keyframe'],
            [2, 100, 'event'],
            [3, 500, 'keyframe'],
            [4, 600, 'event'],
            [5, 800, 'event'],
            [6, 1500, 'keyframe'],
            [7, 3500, 'keyframe'],
            [8, 5500, 'keyframe']
        ]
    );

    const allChunks = recorder.snapshot();
    const latePoll = allChunks.slice(5);
    const initialPoll = allChunks.slice(0, 4);
    const overlappingPoll = [allChunks[6], allChunks[5], allChunks[4], allChunks[3], allChunks[2]];

    const timeline = new ReplayTimeline<ClientReplayFrame>({
        timestampMode: 'v2-relative',
        clockMode: 'recorded'
    });
    const dispatchLog: string[] = [];
    const dispatcher = new ReplayPresentationDispatcher<ClientReplayFrame>({
        handlers: {
            'troop.spawn': (event, context) => {
                dispatchLog.push(`E${context.chunk.sequence}@${context.chunk.t}:${event.type}:${event.payload.troop.id}`);
            },
            'combat.attack': (event, context) => {
                dispatchLog.push(`E${context.chunk.sequence}@${context.chunk.t}:${event.type}:${event.payload.target?.id}`);
            },
            'combat.damage': (event, context) => {
                dispatchLog.push(`E${context.chunk.sequence}@${context.chunk.t}:${event.type}:${event.payload.healthAfter}`);
            }
        },
        onKeyframe: chunk => {
            dispatchLog.push(`K${chunk.sequence}@${chunk.t}:${chunk.frame.buildingHealth}${chunk.terminal ? ':terminal' : ''}`);
        }
    });

    // Concurrent live polls may overlap and complete out of order. Both pure
    // stores must accept that without dispatching through a sequence gap.
    assert.deepEqual(timeline.ingestV2Chunks(latePoll), {
        accepted: 3,
        duplicates: 0,
        lastV2Sequence: 8,
        headT: 5500
    });
    dispatcher.ingest(latePoll);
    assert.deepEqual(dispatcher.dispatchThrough(5500), {
        dispatchedEvents: 0,
        appliedKeyframes: 0,
        nextSequence: 1
    });

    assert.equal(timeline.ingestV2Chunks(initialPoll).accepted, 4);
    dispatcher.ingest(initialPoll);
    const overlapResult = timeline.ingestV2Chunks(overlappingPoll);
    assert.deepEqual(overlapResult, {
        accepted: 1,
        duplicates: 4,
        lastV2Sequence: 8,
        headT: 5500
    });
    dispatcher.ingest(overlappingPoll);

    assert.deepEqual(timeline.keyframes.map(frame => frame.sequence), [1, 3, 6, 7, 8]);
    assert.deepEqual(timeline.events.map(event => event.sequence), [2, 4, 5]);
    assert.deepEqual(timeline.eventsDue(800).map(event => event.sequence), [2, 4, 5]);

    // Seek drives the exact same playhead the canonical dispatcher consumes.
    const dispatchAt = (t: number) => {
        const sample = timeline.seek(t);
        return dispatcher.dispatchThrough(sample.t);
    };
    assert.equal(dispatchAt(0).appliedKeyframes, 1);
    assert.equal(dispatchAt(99).dispatchedEvents, 0);
    assert.equal(dispatchAt(100).dispatchedEvents, 1);
    assert.equal(dispatchAt(500).appliedKeyframes, 1);
    assert.equal(dispatchAt(600).dispatchedEvents, 1);
    assert.equal(dispatchAt(799).dispatchedEvents, 0);
    assert.equal(dispatchAt(800).dispatchedEvents, 1);

    const interpolated = timeline.sample(750);
    assert.equal(interpolated.previous?.sequence, 3);
    assert.equal(interpolated.next?.sequence, 6);
    assert.equal(interpolated.alpha, 0.25);

    assert.equal(dispatchAt(1500).appliedKeyframes, 1);
    assert.equal(dispatchAt(3500).appliedKeyframes, 1);
    assert.equal(dispatchAt(5499).appliedKeyframes, 0);
    assert.equal(dispatchAt(5500).appliedKeyframes, 1);
    assert.deepEqual(dispatchLog, [
        'K1@0:100',
        'E2@100:troop.spawn:troop-1',
        'K3@500:100',
        'E4@600:combat.attack:building-1',
        'E5@800:combat.damage:75',
        'K6@1500:75',
        'K7@3500:75',
        'K8@5500:75:terminal'
    ]);

    // Live-clock proof: once a 2 s keyframe cadence is observed, the adaptive
    // delay grows to 2.5 s. Across the next ideal 2 s producer interval the
    // clock stays above its dry-buffer threshold instead of easing to zero.
    const liveTimeline = new ReplayTimeline<ClientReplayFrame>({
        timestampMode: 'v2-relative',
        clockMode: 'live'
    });
    liveTimeline.ingestV2Chunks(allChunks.slice(0, 7));
    assert.deepEqual(liveTimeline.observedKeyframeGapsMs, [500, 1000, 2000]);
    assert.equal(liveTimeline.recommendedLiveDelayMs, 2500);
    assert.equal(liveTimeline.seekLiveEdge().t, 1000);

    const firstSecond = liveTimeline.advance(1000);
    const secondSecond = liveTimeline.advance(1000);
    assert.equal(firstSecond.effectiveRate, 1);
    assert.equal(secondSecond.effectiveRate, 0.85);
    assert.equal(liveTimeline.keyframeHeadT - liveTimeline.time, 650);
    assert.ok(liveTimeline.keyframeHeadT - liveTimeline.time > 350, 'live clock must not underrun its dry buffer');

    liveTimeline.ingestV2Chunks([terminal]);
    const afterPoll = liveTimeline.advance(100);
    assert.ok(afterPoll.effectiveRate >= 1, 'new head data should replenish and gently catch up the buffer');
    assert.ok(liveTimeline.keyframeHeadT - liveTimeline.time > 2500);
});

test('presentation failures leave the ordered chunk retryable', () => {
    const recorder = new ReplayPresentationRecorder<ClientReplayFrame>({
        streamId: 'attack-client-retry'
    });
    const event = recorder.recordEvent(25, replayPresentationEvent('fx', {
        fx: 'screen-shake',
        durationMs: 50,
        intensity: 0.001,
        townHall: false
    }));
    let attempts = 0;
    const dispatcher = new ReplayPresentationDispatcher<ClientReplayFrame>({
        onEvent: () => {
            attempts += 1;
            if (attempts === 1) throw new Error('synthetic presenter failure');
        }
    });
    dispatcher.ingest([event]);

    assert.throws(() => dispatcher.dispatchThrough(25), /synthetic presenter failure/);
    assert.deepEqual(dispatcher.dispatchThrough(25), {
        dispatchedEvents: 1,
        appliedKeyframes: 0,
        nextSequence: 2
    });
    assert.equal(attempts, 2);
});
