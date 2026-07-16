import Phaser from 'phaser';
import { BUILDING_DEFINITIONS, type BuildingType } from '../config/GameDefinitions';
import { hashString } from '../config/Economy';
import type { VillageLifeManifest } from '../data/Models';
import { PathfindingSystem } from './PathfindingSystem';
import { IsoUtils } from '../utils/IsoUtils';
import { SpriteBank } from '../render/SpriteBank';
import {
    FARMABLE,
    VillageLifeSystem,
    VILLAGER_PALETTES,
    type LifeRole
} from './VillageLifeSystem';
import type { PlacedBuilding } from '../types/GameTypes';

/**
 * Full-quality villagers for neighbour postcards. Population and appearance
 * come from the server's compact life manifest. Motion is not integrated a
 * frame at a time: every position is sampled directly from shared server wall
 * time along a deterministic ambient path. LOD can therefore skip redraws
 * without slowing, teleporting, or otherwise changing the simulation.
 */

const MAX_POPULATION = 30;
const CHILD_AGE_MS = 2 * 86_400_000;

interface SimBuilding {
    id: string;
    type: string;
    gridX: number;
    gridY: number;
    health: number;
    level: number;
}

interface RouteSample {
    x: number;
    y: number;
    facing: 1 | -1;
    moving: boolean;
}

interface SimEntity {
    gfx: Phaser.GameObjects.Graphics;
    route: Phaser.Math.Vector2[];
    routeLength: number;
    speed: number;
    phaseOffsetMs: number;
    dwellStartMs: number;
    dwellEndMs: number;
    palette: number;
    style: number;
    role: LifeRole;
    bornAt?: number;
    elder: boolean;
    watch: boolean;
    animOffset: number;
}

interface NeighborVillageSim {
    offX: number;
    offY: number;
    baseDepth: number;
    simulatedThrough: number;
    buildings: SimBuilding[];
    entities: SimEntity[];
    lastDrawAt: number;
    nextDrawAt: number;
    visible: boolean;
}

function seededRandom(seed: number): () => number {
    let s = (seed | 0) || 1;
    return () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
    };
}

function positiveModulo(value: number, modulus: number): number {
    return ((value % modulus) + modulus) % modulus;
}

function routeLength(points: readonly Phaser.Math.Vector2[]): number {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
        length += Phaser.Math.Distance.BetweenPoints(points[i - 1], points[i]);
    }
    return length;
}

function sampleRoute(points: readonly Phaser.Math.Vector2[], length: number, distance: number): RouteSample {
    if (points.length === 0) return { x: 12.5, y: 12.5, facing: 1, moving: false };
    if (points.length === 1 || length <= 0) {
        return { x: points[0].x, y: points[0].y, facing: 1, moving: false };
    }
    let remaining = Phaser.Math.Clamp(distance, 0, length);
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1];
        const b = points[i];
        const segment = Phaser.Math.Distance.BetweenPoints(a, b);
        if (remaining <= segment || i === points.length - 1) {
            const t = segment > 0 ? Math.min(1, remaining / segment) : 0;
            // Grid +x projects right and grid +y projects left in isometric
            // space, so mirror the figure from its actual screen direction.
            const screenDX = (b.x - a.x) - (b.y - a.y);
            return {
                x: Phaser.Math.Linear(a.x, b.x, t),
                y: Phaser.Math.Linear(a.y, b.y, t),
                facing: screenDX < 0 ? -1 : 1,
                moving: true
            };
        }
        remaining -= segment;
    }
    const last = points[points.length - 1];
    return { x: last.x, y: last.y, facing: 1, moving: false };
}

export class NeighborLifeSim {
    private readonly scene: Phaser.Scene;
    private sims = new Map<string, NeighborVillageSim>();

    constructor(scene: Phaser.Scene) {
        this.scene = scene;
    }

    /** (Re)build one neighbour from its static layout and optional authority. */
    setVillage(
        key: string,
        serialized: ReadonlyArray<{ id?: string; type?: string; gridX?: number; gridY?: number; level?: number }>,
        offX: number,
        offY: number,
        fallbackIdentity: string,
        baseDepth: number,
        manifest?: VillageLifeManifest,
        obstacles?: ReadonlyArray<{ type?: string }>
    ) {
        this.removeVillage(key);
        const buildings: SimBuilding[] = [];
        for (const b of serialized) {
            const info = BUILDING_DEFINITIONS[b.type as BuildingType];
            if (!info) continue;
            buildings.push({
                id: String(b.id ?? `${b.type}:${b.gridX},${b.gridY}`),
                type: String(b.type),
                gridX: Number(b.gridX) || 0,
                gridY: Number(b.gridY) || 0,
                health: 1,
                level: Number(b.level) || 1
            });
        }
        const targets = buildings.filter(b => b.type !== 'wall');
        if (targets.length === 0) return;

        const authorityValid = manifest?.version === 1
            && typeof manifest.identity === 'string'
            && manifest.identity.length > 0
            && Number.isFinite(manifest.population);
        const legacyIdentity = `postcard:${fallbackIdentity || key}`;
        const identity = authorityValid ? manifest.identity : legacyIdentity;
        const population = authorityValid
            ? Phaser.Math.Clamp(Math.floor(manifest.population), 0, MAX_POPULATION)
            : 3 + (hashString(legacyIdentity) % 3);
        const allBirths = authorityValid && Array.isArray(manifest.bornAt)
            ? manifest.bornAt.filter(Number.isFinite).sort((a, b) => b - a).slice(0, MAX_POPULATION)
            : [];
        const simulatedThrough = authorityValid && Number.isFinite(manifest.simulatedThrough)
            ? Math.max(0, manifest.simulatedThrough)
            : 0;
        const bornAt = allBirths.filter(birth => birth + CHILD_AGE_MS > simulatedThrough);

        // Match the live VillageLifeSystem's stable role ordering so resident
        // #N has the same work and visual identity at home and in a postcard.
        // The farmer slot exists for farmable OBSTACLES too (the live sim
        // tends wild greenery when there is no farm) — without that clause a
        // farm-less village's whole roster shifted one role between its live
        // scout view and its postcard.
        const roles: LifeRole[] = [];
        if (targets.some(b => BUILDING_DEFINITIONS[b.type as BuildingType]?.category === 'defense')) roles.push('builder');
        if (targets.some(b => b.type === 'mine')) roles.push('miner');
        if (targets.some(b => b.type === 'farm')
            || (obstacles ?? []).some(o => FARMABLE.has(String(o?.type)))) roles.push('farmer');
        while (roles.length < population) roles.push('peasant');

        // The youngest server-recorded births occupy the tail slots, exactly
        // like the live village. One resident remains an adult worker.
        const birthByIndex = new Map<number, number>();
        const childSlots = Math.min(bornAt.length, Math.max(0, population - 1));
        for (let i = 0; i < childSlots; i++) birthByIndex.set(population - 1 - i, bornAt[i]);

        const entities: SimEntity[] = [];
        for (let i = 0; i < population; i++) {
            const residentIdentity = `${identity}:${i}`;
            const residentSeed = hashString(residentIdentity);
            const rand = seededRandom(hashString(`${residentIdentity}:route`));
            const startHost = targets[Math.floor(rand() * targets.length)];
            const start = this.openTileNear(startHost, buildings, rand);
            let end = start;
            for (let attempt = 0; attempt < 6; attempt++) {
                const candidateHost = targets[Math.floor(rand() * targets.length)];
                const candidate = this.openTileNear(candidateHost, buildings, rand);
                if (candidate.x !== start.x || candidate.y !== start.y) {
                    end = candidate;
                    break;
                }
            }
            const path = PathfindingSystem.findAmbientPath(
                start.x, start.y,
                { gridX: end.x, gridY: end.y },
                buildings as unknown as PlacedBuilding[]
            );
            const route = [new Phaser.Math.Vector2(start.x + 0.5, start.y + 0.5)];
            for (const point of path ?? []) {
                const centered = new Phaser.Math.Vector2(point.x + 0.5, point.y + 0.5);
                const previous = route[route.length - 1];
                if (!previous.equals(centered)) route.push(centered);
            }
            const length = routeLength(route);
            const role = roles[i] ?? 'peasant';
            const born = birthByIndex.get(i);
            const elder = born === undefined && role === 'peasant' && ((residentSeed >> 4) % 5 === 0);
            const speed = (0.00085 + rand() * 0.0004) * (elder ? 0.55 : 1);
            const gfx = this.scene.add.graphics();
            gfx.setDepth(baseDepth);
            entities.push({
                gfx,
                route,
                routeLength: length,
                speed,
                phaseOffsetMs: hashString(`${residentIdentity}:phase`) * 17,
                dwellStartMs: 1800 + Math.floor(rand() * 5200),
                dwellEndMs: 1800 + Math.floor(rand() * 5200),
                palette: residentSeed % VILLAGER_PALETTES.length,
                style: role === 'peasant' && !elder && ((residentSeed >> 8) % 5 < 2) ? 1 : 0,
                role,
                bornAt: born,
                elder,
                watch: i === 0,
                animOffset: (residentSeed >> 12) % 10_000
            });
        }

        this.sims.set(key, {
            offX,
            offY,
            baseDepth,
            simulatedThrough,
            buildings,
            entities,
            lastDrawAt: 0,
            nextDrawAt: 0,
            visible: false
        });
    }

    removeVillage(key: string) {
        const sim = this.sims.get(key);
        if (!sim) return;
        for (const entity of sim.entities) entity.gfx.destroy();
        this.sims.delete(key);
    }

    destroy() {
        for (const key of [...this.sims.keys()]) this.removeVillage(key);
    }

    /** Redraw at the requested LOD frequency; state always comes from wall time. */
    tick(key: string, serverWallTime: number, hz: number, visible: boolean, nightFactor: number) {
        const sim = this.sims.get(key);
        if (!sim) return;
        if (!visible) {
            if (sim.visible) for (const entity of sim.entities) entity.gfx.setVisible(false);
            sim.visible = false;
            return;
        }
        const becameVisible = !sim.visible;
        sim.visible = true;
        const sampleAt = Math.max(sim.simulatedThrough, Number.isFinite(serverWallTime) ? serverWallTime : sim.simulatedThrough);
        // A corrected server offset may move the wall clock backwards. Redraw
        // immediately in that case instead of waiting for the old deadline.
        if (!becameVisible && sampleAt >= sim.lastDrawAt && sampleAt < sim.nextDrawAt) return;
        sim.lastDrawAt = sampleAt;
        // Deadlines land ON the hz grid in absolute wall time. Accumulating
        // `sampleAt + step` instead compounds the caller's frame rounding —
        // ticks offered every ~16.7 ms would redraw only every 3rd frame
        // (~20 Hz) when the near-ring LOD asks for the 24 Hz figure clock.
        const step = 1000 / Math.max(0.5, hz);
        sim.nextDrawAt = (Math.floor(sampleAt / step) + 1) * step;

        for (const entity of sim.entities) {
            const sample = this.sample(entity, sampleAt);
            this.place(sim, entity, sample, sampleAt, nightFactor);
        }
    }

    private sample(entity: SimEntity, time: number): RouteSample {
        if (entity.routeLength <= 0) return sampleRoute(entity.route, entity.routeLength, 0);
        const matureAt = entity.bornAt !== undefined ? entity.bornAt + CHILD_AGE_MS : undefined;
        const child = matureAt !== undefined && time < matureAt;
        const speed = entity.speed * (child ? 1.35 : 1);
        const travelMs = entity.routeLength / speed;
        const period = entity.dwellStartMs + travelMs + entity.dwellEndMs + travelMs;
        let phase: number;
        if (matureAt !== undefined && !child && time >= matureAt) {
            // The child's quicker gait had a shorter cycle; switching period
            // at maturity would jump `time mod period` — a one-time teleport
            // along the route. Anchor the adult cycle at the maturation
            // instant, mapping the child's segment position (dwell fraction /
            // route distance) into the adult cycle so the walk is continuous.
            const childSpeed = entity.speed * 1.35;
            const childTravel = entity.routeLength / childSpeed;
            const childPeriod = entity.dwellStartMs + childTravel + entity.dwellEndMs + childTravel;
            const pc = positiveModulo(matureAt + entity.phaseOffsetMs, childPeriod);
            let anchor: number;
            if (pc < entity.dwellStartMs) {
                anchor = pc;
            } else if (pc < entity.dwellStartMs + childTravel) {
                anchor = entity.dwellStartMs + ((pc - entity.dwellStartMs) / childTravel) * travelMs;
            } else if (pc < entity.dwellStartMs + childTravel + entity.dwellEndMs) {
                anchor = entity.dwellStartMs + travelMs + (pc - entity.dwellStartMs - childTravel);
            } else {
                anchor = entity.dwellStartMs + travelMs + entity.dwellEndMs
                    + ((pc - entity.dwellStartMs - childTravel - entity.dwellEndMs) / childTravel) * travelMs;
            }
            phase = positiveModulo(anchor + (time - matureAt), period);
        } else {
            phase = positiveModulo(time + entity.phaseOffsetMs, period);
        }
        if (phase < entity.dwellStartMs) {
            return { ...sampleRoute(entity.route, entity.routeLength, 0), moving: false };
        }
        phase -= entity.dwellStartMs;
        if (phase < travelMs) return sampleRoute(entity.route, entity.routeLength, phase * speed);
        phase -= travelMs;
        if (phase < entity.dwellEndMs) {
            return { ...sampleRoute(entity.route, entity.routeLength, entity.routeLength), moving: false };
        }
        phase -= entity.dwellEndMs;
        const reverse = sampleRoute(entity.route, entity.routeLength, entity.routeLength - phase * speed);
        return { ...reverse, facing: reverse.facing === 1 ? -1 : 1 };
    }

    /** A deterministic free tile hugging a building's viewer-facing sides. */
    private openTileNear(b: SimBuilding, buildings: SimBuilding[], rand: () => number): { x: number; y: number } {
        const info = BUILDING_DEFINITIONS[b.type as BuildingType];
        const w = info?.width ?? 1;
        const h = info?.height ?? 1;
        const candidates: Array<{ x: number; y: number }> = [];
        for (let k = 0; k < w; k++) candidates.push({ x: b.gridX + k, y: b.gridY + h });
        for (let k = 0; k < h; k++) candidates.push({ x: b.gridX + w, y: b.gridY + k });
        const blocked = (x: number, y: number) => buildings.some(other => {
            const otherInfo = BUILDING_DEFINITIONS[other.type as BuildingType];
            if (!otherInfo) return false;
            return x >= other.gridX && x < other.gridX + otherInfo.width
                && y >= other.gridY && y < other.gridY + otherInfo.height;
        });
        const open = candidates.filter(candidate => candidate.x >= 0 && candidate.y >= 0
            && candidate.x < 25 && candidate.y < 25 && !blocked(candidate.x, candidate.y));
        if (open.length === 0) {
            return { x: Phaser.Math.Clamp(b.gridX + w, 0, 24), y: Phaser.Math.Clamp(b.gridY + h, 0, 24) };
        }
        return open[Math.floor(rand() * open.length)];
    }

    /** Approximate building occlusion over the postcard's flat raised layer. */
    private occluded(sim: NeighborVillageSim, x: number, y: number): boolean {
        for (const building of sim.buildings) {
            if (building.type === 'wall') continue;
            const info = BUILDING_DEFINITIONS[building.type as BuildingType];
            if (!info) continue;
            if ((building.gridX + info.width / 2) + (building.gridY + info.height / 2) <= x + y) continue;
            if (x >= building.gridX - 0.6 && x <= building.gridX + info.width + 0.6
                && y >= building.gridY - 0.6 && y <= building.gridY + info.height + 0.6) return true;
        }
        return false;
    }

    /** Position and redraw through the exact home-village vector art function. */
    private place(
        sim: NeighborVillageSim,
        entity: SimEntity,
        sample: RouteSample,
        time: number,
        nightFactor: number
    ) {
        // Match the home village's night routine: one lantern watch remains
        // outside while the rest are indoors. Population stays authoritative;
        // sleeping residents are hidden, not deleted or downsampled.
        // 0.6 matches the home village's bedtime threshold (MainScene gates
        // setNightMode on nightFactor() > 0.6) so neighbours turn in with you.
        const show = (nightFactor <= 0.6 || entity.watch)
            && !this.occluded(sim, sample.x, sample.y);
        entity.gfx.setVisible(show);
        if (!show) return;
        const point = IsoUtils.cartToIso(sim.offX + sample.x, sim.offY + sample.y);
        entity.gfx.setPosition(point.x, point.y);
        entity.gfx.setDepth(sim.baseDepth + (sample.x + sample.y) * 0.0001);
        const child = entity.bornAt !== undefined && time < entity.bornAt + CHILD_AGE_MS;
        const scale = child ? 0.55 : 0.8;
        const phase = positiveModulo(time + entity.animOffset, 460) / 460;
        entity.gfx.clear();
        entity.gfx.setScale(sample.facing === -1 ? -scale : scale, scale);
        // Baked-sprite path — same variant/state model as the home village.
        const lantern = entity.watch && nightFactor > 0.6;
        const variant = `p${entity.palette}s${entity.style}_${child ? 'child' : entity.elder ? 'elder' : entity.role}`;
        const state = lantern ? (sample.moving ? 'lantern_walk' : 'lantern_idle')
            : sample.moving ? 'walk' : 'idle';
        if (SpriteBank.syncFigure(this.scene, entity.gfx, 'villager', variant, state, phase, sample.facing === -1)) {
            return;
        }
        SpriteBank.release(entity.gfx);
        VillageLifeSystem.drawVillager(
            entity.gfx,
            VILLAGER_PALETTES[entity.palette],
            entity.style,
            phase,
            sample.moving,
            false,
            false,
            entity.role,
            false,
            0,
            entity.elder,
            false,
            lantern,
            undefined,
            undefined,
            child
        );
    }
}
