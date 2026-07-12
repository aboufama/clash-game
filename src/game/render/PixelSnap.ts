import Phaser from 'phaser';

/**
 * PixelSnap — the world-anchored pixel-quantize shader (the exact math the
 * old full-screen Pixelate used), revived as a PER-LAYER post pipeline for
 * layers that genuinely redraw every frame and therefore cannot pre-bake:
 * rain and splashes, fireflies and night glows, the living cloud edge,
 * village-life figures, stone lanes, worn paths, travellers, particles,
 * projectile FX. Baked sprites and quantized RenderTextures never get this
 * (their pixels are already committed); this closes the gap so LITERALLY
 * every non-UI layer reads as pixel art.
 *
 * The pass count stays bounded because it is applied to layer-level Graphics
 * (one per system concern), not to every tiny object.
 *
 * Kill switch: localStorage 'clash.pixelsnap.off' = '1'.
 */

const CELL = 1.35;

const fragShader = `
precision mediump float;
uniform sampler2D uMainSampler;
uniform vec2 uResolution;
uniform float uSize;
uniform float uZoom;
uniform vec2 uScroll;
varying vec2 outTexCoord;

void main()
{
    if (uSize <= 1.0) {
        gl_FragColor = texture2D(uMainSampler, outTexCoord);
    } else {
        float eff = max(uSize, 1.0 / uZoom);
        vec2 worldPos = (outTexCoord * uResolution) / uZoom + uScroll;
        vec2 snappedWorldPos = floor(worldPos / eff) * eff + eff * 0.5;
        vec2 sourcePixelPos = (snappedWorldPos - uScroll) * uZoom;
        vec2 sampleUV = (floor(sourcePixelPos) + 0.5) / uResolution;
        sampleUV = clamp(sampleUV, 1.5 / uResolution, 1.0 - 1.5 / uResolution);
        gl_FragColor = texture2D(uMainSampler, sampleUV);
    }
}
`;

class PixelSnapPipeline extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
    constructor(game: Phaser.Game) {
        super({ game, fragShader, name: 'PixelSnap' });
    }
    onPreRender() {
        const cam = (this.game.scene.getScene('MainScene') as Phaser.Scene | null)?.cameras?.main;
        this.set1f('uSize', CELL);
        this.set1f('uZoom', cam?.zoom ?? 1);
        this.set2f('uScroll', cam?.scrollX ?? 0, cam?.scrollY ?? 0);
        this.set2f('uResolution', this.renderer.width, this.renderer.height);
    }
}

let disabled: boolean | null = null;

/** Apply the snap to one layer object. Registers the pipeline on first use;
 * idempotent, so per-frame draw sites may call it unconditionally. */
export function applyPixelSnap(
    scene: Phaser.Scene,
    obj: Phaser.GameObjects.GameObject & {
        setPostPipeline?: (p: string) => unknown;
        postPipelines?: Array<{ name: string }>;
    }
): void {
    if (disabled === null) {
        try { disabled = localStorage.getItem('clash.pixelsnap.off') === '1'; } catch { disabled = false; }
    }
    if (disabled) return;
    if (obj.postPipelines?.some(p => p.name === 'PixelSnap')) return;
    const renderer = scene.game.renderer;
    if (renderer.type !== Phaser.WEBGL) return;
    const pipelines = (renderer as Phaser.Renderer.WebGL.WebGLRenderer).pipelines;
    if (!pipelines.has('PixelSnap')) {
        pipelines.addPostPipeline('PixelSnap', PixelSnapPipeline);
    }
    obj.setPostPipeline?.('PixelSnap');
}
