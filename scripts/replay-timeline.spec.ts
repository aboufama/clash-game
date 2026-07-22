import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ReplayTimeline,
    computeLiveJitterDelay,
    dampWrappedFacing,
    interpolateReplayPose,
    interpolateWrappedFacing,
    wrapFacingAngle
} from '../src/game/replay/ReplayTimeline.ts';
import type { ReplayV2Chunk } from '../src/game/replay/ReplayTypes.ts';

interface Frame {
    t?: number;
    x: number;
}

interface Event {
    type: 'hit';
    targetId: string;
}

const closeTo = (actual: number, expected: number, epsilon = 1e-9) => {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} was not within ${epsilon} of ${expected}`);
};

test('legacy frames normalize from the earliest timestamp and preserve raw clock position', () => {
    const timeline = new ReplayTimeline<Frame>({ timestampMode: 'legacy' });
    timeline.ingestLegacyKeyframes([
        { t: 1200, x: 12 },
        { t: 1000, x: 10 }
    ]);
    assert.deepEqual(timeline.keyframes.map(frame => [frame.rawT, frame.t]), [[1000, 0], [1200, 200]]);

    timeline.seek(100);
    timeline.ingestLegacyKeyframes([{ t: 900, x: 9 }]);
    assert.equal(timeline.time, 200, 'normalized cursor still represents raw t=1100');
    assert.deepEqual(
        timeline.keyframes.map(frame => [frame.rawT, frame.t]),
        [[900, 0], [1000, 100], [1200, 300]]
    );
});

test('v2 relative and absolute timestamps normalize without scene-time leakage', () => {
    const relative = new ReplayTimeline<Frame, Event>({ timestampMode: 'v2-relative' });
    relative.ingestV2Chunks([{ sequence: 1, t: 250, kind: 'keyframe', frame: { x: 1 } }]);
    assert.equal(relative.keyframes[0].t, 250);

    const absolute = new ReplayTimeline<Frame, Event>({
        timestampMode: 'v2-absolute',
        originMs: 50_000
    });
    absolute.ingestV2Chunks([{ sequence: 1, t: 50_250, kind: 'keyframe', frame: { x: 1 } }]);
    assert.equal(absolute.keyframes[0].t, 250);
});

test('v2 chunks ingest out of order, remain ordered, and dedupe by sequence', () => {
    const timeline = new ReplayTimeline<Frame, Event>();
    const chunks: ReplayV2Chunk<Frame, Event>[] = [
        { sequence: 4, t: 200, kind: 'event', event: { type: 'hit', targetId: 'b' } },
        { sequence: 1, t: 0, kind: 'keyframe', frame: { x: 0 } },
        { sequence: 3, t: 100, kind: 'event', event: { type: 'hit', targetId: 'a' } },
        { sequence: 2, t: 100, kind: 'keyframe', frame: { x: 1 } },
        { sequence: 5, t: 300, kind: 'keyframe', terminal: true, frame: { x: 3 } }
    ];
    const first = timeline.ingestV2Chunks(chunks);
    const second = timeline.ingestV2Chunks(chunks);

    assert.deepEqual(first, { accepted: 5, duplicates: 0, lastV2Sequence: 5, headT: 300 });
    assert.deepEqual(second, { accepted: 0, duplicates: 5, lastV2Sequence: 5, headT: 300 });
    assert.deepEqual(timeline.keyframes.map(frame => frame.sequence), [1, 2, 5]);
    assert.deepEqual(timeline.events.map(event => event.sequence), [3, 4]);
    assert.equal(timeline.terminalT, 300);
    assert.throws(
        () => timeline.ingestV2Chunks([
            { sequence: 3, t: 101, kind: 'event', event: { type: 'hit', targetId: 'conflict' } }
        ]),
        /Conflicting replay-v2 chunk sequence 3/
    );
});

test('sampling, seek, event crossing, and terminal completion are deterministic', () => {
    const timeline = new ReplayTimeline<Frame, Event>({ playbackRate: 2 });
    timeline.ingestV2Chunks([
        { sequence: 1, t: 0, kind: 'keyframe', frame: { x: 0 } },
        { sequence: 2, t: 0, kind: 'event', event: { type: 'hit', targetId: 'at-zero' } },
        { sequence: 3, t: 250, kind: 'event', event: { type: 'hit', targetId: 'middle' } },
        { sequence: 4, t: 1000, kind: 'keyframe', terminal: true, frame: { x: 10 } }
    ]);

    const sample = timeline.seek(250);
    assert.equal(sample.previous?.frame.x, 0);
    assert.equal(sample.next?.frame.x, 10);
    closeTo(sample.alpha, 0.25);
    assert.deepEqual(timeline.eventsDue(250).map(event => event.sequence), [2, 3]);

    timeline.seek(0);
    const step = timeline.advance(125);
    assert.equal(step.toT, 250);
    assert.deepEqual(step.events.map(event => event.sequence), [3]);
    timeline.advance(375);
    assert.equal(timeline.time, 1000);
    assert.equal(timeline.complete, true);
});

test('wrapped facing takes the shortest arc and damping is frame-rate independent', () => {
    const from = 350 * Math.PI / 180;
    const to = 10 * Math.PI / 180;
    closeTo(wrapFacingAngle(interpolateWrappedFacing(from, to, 0.5)), 0, 1e-12);

    const simulate = (fps: number): number => {
        let angle = from;
        const steps = fps;
        const delta = 1000 / steps;
        for (let index = 0; index < steps; index++) {
            angle = dampWrappedFacing(angle, to, delta, 90);
        }
        return angle;
    };
    const at30 = simulate(30);
    closeTo(at30, simulate(60), 1e-12);
    closeTo(at30, simulate(120), 1e-12);

    const pose = interpolateReplayPose(
        { gridX: 0, gridY: 2, facingAngle: from },
        { gridX: 10, gridY: 6, facingAngle: to },
        0.5
    );
    closeTo(pose.gridX, 5);
    closeTo(pose.gridY, 4);
    closeTo(pose.facingAngle ?? Infinity, 0, 1e-12);
});

test('live jitter delay grows above observed producer gaps', () => {
    assert.equal(computeLiveJitterDelay([]), 1500);
    assert.equal(computeLiveJitterDelay([500, 1000]), 1500);
    assert.equal(computeLiveJitterDelay([500, 1000, 2000]), 2500);

    const timeline = new ReplayTimeline<Frame, Event>({ clockMode: 'live' });
    timeline.ingestV2Chunks([
        { sequence: 1, t: 0, kind: 'keyframe', frame: { x: 0 } },
        { sequence: 2, t: 500, kind: 'keyframe', frame: { x: 1 } },
        { sequence: 3, t: 1500, kind: 'keyframe', frame: { x: 2 } },
        { sequence: 4, t: 3500, kind: 'keyframe', frame: { x: 3 } }
    ]);
    assert.deepEqual(timeline.observedKeyframeGapsMs, [500, 1000, 2000]);
    assert.equal(timeline.recommendedLiveDelayMs, 2500);
    assert.equal(timeline.seekLiveEdge().t, 1000);

    const step = timeline.advance(100);
    assert.ok(step.effectiveRate > 0);
    assert.ok(step.toT > step.fromT);
    assert.ok(step.toT <= timeline.keyframeHeadT);
});
