import Phaser from 'phaser';
import { IsoUtils } from '../utils/IsoUtils';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import { armySpaceUsed, campCapacityOf } from '../config/Economy';
import { gameManager } from '../GameManager';
import type { SerializedBuilding } from '../data/Models';
import { cameraDisplayScale } from '../utils/DisplayResolution';

interface BubbleHost extends Phaser.Scene {
    mode: string;
    buildings: Array<{ type: string; gridX: number; gridY: number; health: number; owner?: string }>;
    dayNight?: { nightFactor(): number };
}

export interface VillageBubbleSpec {
    /** One bubble per key; raising again refreshes it in place. */
    key: string;
    text: string;
    kind?: 'info' | 'danger';
    /** Hang over the first standing building of this type (town hall fallback). */
    buildingType?: string;
    /** Or over an explicit world-space point. */
    anchor?: { x: number; y: number };
    /** Auto-dismiss after this long; 0 = stays until cleared. Default 8s. */
    ttlMs?: number;
    action?: { label: string; run: () => void };
    closable?: boolean;
    /** A pixel icon class ('build-icon', 'sym sym-shield', ...) shown before the text. */
    icon?: string;
    /** Bob the icon — a two-step working animation (hammering, ringing). */
    animate?: boolean;
    /** Live 0..1 progress, polled each frame into a pixel bar under the text. */
    progress?: () => number;
}

interface LiveBubble {
    el: HTMLDivElement;
    spec: VillageBubbleSpec;
    until: number; // 0 = sticky
    fill: HTMLElement | null;
}

/**
 * Diegetic village speech: pixel-art bubbles that buildings raise over their
 * own roofs — the watchtower sounding the raid alarm, the storehouse groaning
 * at its cap, the camp reporting the army mustered, the merchant calling out.
 * DOM chips in the same crisp parchment frames as every other bubble,
 * positioned each frame like the nameplates.
 */
export class VillageBubbles {
    private readonly scene: BubbleHost;
    private layer: HTMLDivElement | null = null;
    private bubbles = new Map<string, LiveBubble>();
    private cooldownUntil = new Map<string, number>();
    private nextEventScanAt = 0;
    private wasArmyFull = false;
    private wasNight = false;

    constructor(scene: BubbleHost) {
        this.scene = scene;
    }

    private ensureLayer(): HTMLDivElement | null {
        if (this.layer && this.layer.isConnected) return this.layer;
        const host = document.getElementById('game-container');
        if (!host) return null;
        const layer = document.createElement('div');
        layer.className = 'village-bubble-layer';
        host.appendChild(layer);
        this.layer = layer;
        return layer;
    }

    /** World-space point a bubble should hang from. */
    private anchorFor(spec: VillageBubbleSpec): { x: number; y: number } | null {
        if (spec.anchor) return spec.anchor;
        const pick = (type: string) =>
            this.scene.buildings.find(b => b.type === type && b.health > 0 && b.owner !== 'ENEMY');
        const building = (spec.buildingType && pick(spec.buildingType)) || pick('town_hall');
        if (!building) return null;
        const def = BUILDING_DEFINITIONS[building.type as BuildingType];
        const w = def?.width ?? 1;
        const h = def?.height ?? 1;
        const p = IsoUtils.cartToIso(building.gridX + w / 2, building.gridY + h / 2);
        return { x: p.x, y: p.y - 46 - h * 11 };
    }

    raise(spec: VillageBubbleSpec) {
        const layer = this.ensureLayer();
        if (!layer) return;
        this.clear(spec.key);

        const el = document.createElement('div');
        el.className = `village-bubble ${spec.kind === 'danger' ? 'danger' : ''}`;
        const row = document.createElement('span');
        row.className = 'vb-row';
        if (spec.icon) {
            const icon = document.createElement('span');
            icon.className = `${spec.icon.includes('sym') ? 'sym small ' : 'icon '}${spec.icon} vb-icon ${spec.animate ? 'working' : ''}`;
            row.appendChild(icon);
        }
        const text = document.createElement('span');
        text.className = 'vb-text';
        text.textContent = spec.text;
        row.appendChild(text);
        el.appendChild(row);
        let fill: HTMLElement | null = null;
        if (spec.progress) {
            const bar = document.createElement('span');
            bar.className = 'px-bar vb-bar';
            fill = document.createElement('i');
            bar.appendChild(fill);
            el.appendChild(bar);
        }
        if (spec.action) {
            const btn = document.createElement('button');
            btn.className = 'vb-action';
            btn.textContent = spec.action.label;
            btn.addEventListener('pointerdown', event => event.stopPropagation());
            btn.addEventListener('click', event => {
                event.stopPropagation();
                spec.action?.run();
            });
            el.appendChild(btn);
        }
        if (spec.closable) {
            const close = document.createElement('button');
            close.className = 'vb-close';
            close.textContent = '×';
            close.addEventListener('click', event => {
                event.stopPropagation();
                this.clear(spec.key);
            });
            el.appendChild(close);
        }
        const tail = document.createElement('span');
        tail.className = `px-tail ${spec.kind === 'danger' ? 'danger' : ''}`;
        el.appendChild(tail);
        layer.appendChild(el);

        const ttl = spec.ttlMs ?? 8000;
        this.bubbles.set(spec.key, { el, spec, until: ttl > 0 ? this.scene.time.now + ttl : 0, fill });
    }

    /** raise() with a per-key cooldown — for recurring conditions. */
    raiseOnce(spec: VillageBubbleSpec, cooldownMs: number) {
        const now = this.scene.time.now;
        if ((this.cooldownUntil.get(spec.key) ?? 0) > now) return;
        this.cooldownUntil.set(spec.key, now + cooldownMs);
        this.raise(spec);
    }

    clear(key: string) {
        const live = this.bubbles.get(key);
        if (!live) return;
        this.bubbles.delete(key);
        live.el.remove();
    }

    has(key: string): boolean {
        return this.bubbles.has(key);
    }

    /** Per-frame bookkeeping: expire bubbles, poll progress bars, scan events. */
    update(time: number) {
        this.scanBakedEvents(time);
        for (const [key, live] of [...this.bubbles]) {
            if (live.until > 0 && time >= live.until) {
                this.clear(key);
                continue;
            }
            if (live.fill && live.spec.progress) {
                const pct = Math.max(0, Math.min(1, live.spec.progress()));
                live.fill.style.width = `${Math.round(pct * 100)}%`;
            }
        }
    }

    /**
     * Pin every chip to its anchor. Called from the scene's POST_RENDER sync
     * (see cameraFrame.ts) with the camera the canvas was just drawn from —
     * positioning here rather than in update() keeps the chips glued to the
     * world during drags instead of trailing the canvas by a frame.
     */
    reposition(cam: Phaser.Cameras.Scene2D.Camera) {
        if (this.bubbles.size === 0) return;
        const home = this.scene.mode === 'HOME';
        // Bubbles sharing a roof stack upward instead of overlapping.
        const stackHeight = new Map<string, number>();
        for (const live of this.bubbles.values()) {
            if (!home) {
                live.el.style.display = 'none';
                continue;
            }
            const anchor = this.anchorFor(live.spec);
            if (!anchor) {
                live.el.style.display = 'none';
                continue;
            }
            const wv = cam.worldView;
            const display = cameraDisplayScale(cam);
            const viewportWidth = cam.width / display.x;
            const viewportHeight = cam.height / display.y;
            const sx = (anchor.x - wv.x) * cam.zoom / display.x;
            let sy = (anchor.y - wv.y) * cam.zoom / display.y;
            const bucket = `${Math.round(sx / 60)}:${Math.round(sy / 60)}`;
            const liftSoFar = stackHeight.get(bucket) ?? 0;
            sy -= liftSoFar;
            if (sx < -200 || sx > viewportWidth + 200 || sy < -120 || sy > viewportHeight + 120) {
                live.el.style.display = 'none';
                continue;
            }
            live.el.style.display = '';
            live.el.style.transform = `translate(-50%, -100%) translate(${Math.round(sx)}px, ${Math.round(sy)}px)`;
            stackHeight.set(bucket, liftSoFar + live.el.offsetHeight + 10);
        }
    }

    /**
     * The baked-in interactions: conditions the village reports on its own.
     * Scanned at a walking pace — none of this is frame-critical.
     */
    private scanBakedEvents(time: number) {
        if (time < this.nextEventScanAt) return;
        this.nextEventScanAt = time + 5000;
        if (this.scene.mode !== 'HOME') return;
        const buildings = this.scene.buildings.filter(b => b.owner !== 'ENEMY' && b.health > 0);
        if (buildings.length === 0) return;

        // No storage-full nag bubbles: the storehouse shows its fill level
        // directly in its info bubble when tapped instead.

        // The camp reports the army mustered (on the moment it fills).
        const capacity = campCapacityOf(buildings as unknown as SerializedBuilding[]);
        const used = armySpaceUsed(gameManager.getArmy());
        const full = capacity > 0 && used >= capacity;
        if (full && !this.wasArmyFull) {
            this.raiseOnce({ key: 'army-ready', buildingType: 'army_camp', text: 'The army is mustered and ready!' }, 10 * 60_000);
        }
        this.wasArmyFull = full;

        // Nightfall: the tower lights its brazier and calls the hour.
        const night = (this.scene.dayNight?.nightFactor() ?? 0) > 0.6;
        if (night && !this.wasNight && buildings.some(b => b.type === 'watchtower')) {
            this.raiseOnce({ key: 'night-watch', buildingType: 'watchtower', text: 'The watch is lit. All quiet.' , ttlMs: 7000 }, 60 * 60_000);
        }
        this.wasNight = night;
    }

    teardown() {
        for (const key of [...this.bubbles.keys()]) this.clear(key);
        this.layer?.remove();
        this.layer = null;
    }
}
