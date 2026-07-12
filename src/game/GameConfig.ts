
import Phaser from 'phaser';
import { MainScene } from './scenes/MainScene';
import { BattleOverlayScene } from './scenes/BattleOverlayScene';
import { adoptInitialDisplayMetrics, computeDisplayMetrics } from './utils/DisplayResolution';
import { MobileUtils } from './utils/MobileUtils';

/** Build from the mounted parent so a delayed auth boot cannot use stale viewport dimensions. */
export function createGameConfig(parent: HTMLElement): Phaser.Types.Core.GameConfig {
    const isMobile = MobileUtils.isMobile();
    const rect = parent.getBoundingClientRect();
    const metrics = adoptInitialDisplayMetrics(computeDisplayMetrics(
        parent.clientWidth || rect.width || window.innerWidth,
        parent.clientHeight || rect.height || window.innerHeight,
        { isMobile, devicePixelRatio: window.devicePixelRatio || 1 }
    ));

    return {
        type: Phaser.AUTO,
        width: metrics.backingWidth,
        height: metrics.backingHeight,
        parent,
        backgroundColor: '#87CEEB', // Sky color, or we fill with grass
        scene: [MainScene, BattleOverlayScene],
        // Phaser 3.90 has no game `resolution` option. NONE + inverse CSS
        // zoom is its supported way to keep a high-DPI backing buffer while
        // the canvas occupies the parent's logical CSS size.
        scale: {
            mode: Phaser.Scale.NONE,
            width: metrics.backingWidth,
            height: metrics.backingHeight,
            zoom: 1 / metrics.renderScale,
            autoCenter: Phaser.Scale.NO_CENTER
        },
        physics: {
            default: 'arcade',
            arcade: {
                debug: false
            }
        },
        // Mobile optimizations
        fps: {
            target: isMobile ? 30 : 60, // Lower FPS target on mobile for battery life
            forceSetTimeOut: isMobile // More battery-friendly on mobile
        },
        render: {
            antialias: true,
            antialiasGL: true,
            // Explicit false is required because Phaser otherwise defaults
            // pixelArt to true whenever ScaleManager zoom is not exactly 1.
            pixelArt: false,
            roundPixels: false,
            powerPreference: isMobile ? 'low-power' : 'high-performance'
        },
        input: {
            touch: true,
            mouse: true
        }
    };
}
