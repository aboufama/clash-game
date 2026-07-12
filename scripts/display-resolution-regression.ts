import assert from 'node:assert/strict';
import {
    DESKTOP_BACKING_PIXEL_BUDGET,
    MOBILE_BACKING_PIXEL_BUDGET,
    computeDisplayMetrics,
    toBackingZoom,
    toLogicalZoom
} from '../src/game/utils/DisplayResolution';

const desktopRetina = computeDisplayMetrics(1920, 1080, {
    isMobile: false,
    devicePixelRatio: 3
});
assert.equal(desktopRetina.renderScale, 2, 'desktop DPR must cap at 2');
assert.deepEqual(
    [desktopRetina.backingWidth, desktopRetina.backingHeight],
    [3840, 2160],
    '1080p Retina must receive a 4K backing buffer'
);
assert.ok(
    desktopRetina.backingWidth * desktopRetina.backingHeight <= DESKTOP_BACKING_PIXEL_BUDGET,
    'desktop backing buffer must respect its pixel budget'
);

const desktop1440 = computeDisplayMetrics(2560, 1440, {
    isMobile: false,
    devicePixelRatio: 2
});
assert.equal(desktop1440.renderScale, 1.5, '1440p must budget down to a 4K backing buffer');
assert.deepEqual([desktop1440.backingWidth, desktop1440.backingHeight], [3840, 2160]);

const mobile = computeDisplayMetrics(390, 844, {
    isMobile: true,
    devicePixelRatio: 3
});
assert.equal(mobile.renderScale, 1.5, 'mobile DPR must cap at 1.5');
assert.ok(
    mobile.backingWidth * mobile.backingHeight <= MOBILE_BACKING_PIXEL_BUDGET,
    'mobile backing buffer must respect its pixel budget'
);

const fourK = computeDisplayMetrics(3840, 2160, {
    isMobile: false,
    devicePixelRatio: 2
});
assert.equal(fourK.renderScale, 1, 'native 4K already consumes the desktop pixel budget');

const oneX = computeDisplayMetrics(1280, 720, {
    isMobile: false,
    devicePixelRatio: 1
});
assert.equal(oneX.renderScale, 1, 'ordinary displays must remain one backing pixel per CSS pixel');

for (const scale of [1, 1.25, 1.5, 2]) {
    const logical = 0.73;
    assert.ok(
        Math.abs(toLogicalZoom(toBackingZoom(logical, scale), scale) - logical) < 1e-12,
        `logical/backing camera zoom must round-trip at scale ${scale}`
    );
}

console.log('Display resolution regression passed');
