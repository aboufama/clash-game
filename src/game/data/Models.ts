
import type { BuildingType, ObstacleType } from "../config/GameDefinitions";

export interface SerializedBuilding {
    id: string; // Unique instance ID (UUID)
    type: BuildingType;
    gridX: number;
    gridY: number;
    level: number;
    /** Server-stamped at placement/upgrade completion — drives the visual patina of age. */
    builtAt?: number;
    /** SERVER-OWNED upgrade timer: the level this building is working toward.
     *  While set, `level` stays at the old value, the building is offline
     *  (defenses don't fire, production pauses) and further upgrades are
     *  refused. The server materializes the level when the clock matures;
     *  clients mirror it locally but the server's word is final. */
    upgradingTo?: number;
    /** Server-stamped epoch ms when the pending upgrade began. */
    upgradeStartedAt?: number;
    /** Epoch ms when the pending upgrade completes. */
    upgradeEndsAt?: number;
}

export interface SerializedObstacle {
    id: string;
    type: ObstacleType;
    gridX: number;
    gridY: number;
}

export interface PlayerResources {
    gold: number;
    /**
     * Ore and food: server-authoritative stocks awaiting the economy sim
     * (mine/farm buildings, worker output, upkeep). Optional for backward
     * compatibility with pre-resource world payloads.
     */
    ore?: number;
    food?: number;
}

/**
 * Server-authoritative village population. Today it drives the living
 * villagers rendered in the client; it is the anchor point for the coming
 * economy sim (worker assignments, production boosts, upkeep), so treat it
 * like resources: the server owns it, the client only displays it.
 */
export interface WorldPopulation {
    /** Current inhabitants. Grows over time toward capacity (each arrival eats food). */
    count: number;
    /** Housing provided by the current layout. */
    capacity: number;
    /** Hands required to run every mine and farm at full rate. */
    workersNeeded?: number;
    /** population/workersNeeded capped at 1 — production runs at this fraction. */
    staffing?: number;
    /** Birth timestamps of the youngest villagers — they render as children until of age. */
    bornAt?: number[];
}

/**
 * Compact public authority for ambient residents. The client derives motion
 * from this stable identity and the shared server clock without receiving or
 * simulating one networked entity per person.
 */
export interface VillageLifeManifest {
    version: 1;
    identity: string;
    population: number;
    bornAt: number[];
    simulatedThrough: number;
}

/**
 * The village banner — the owner's explicit heraldry choice, persisted
 * server-side and rendered identically everywhere the village flies a flag
 * (town hall, war camp, world-map postcards). All axes are bounded enums;
 * anything missing/invalid falls back to the deterministic identity-derived
 * default (`villageFlagFor`), so pre-banner villages need no migration.
 */
export interface VillageBanner {
    /** Index into the shared heraldry field palette (VillageFlagRenderer FIELDS). */
    palette: number;
    /** Charge: 0 tower · 1 blade · 2 oak leaf · 3 star · 4 crescent · 5 hammer. */
    emblem: number;
    /** Field division: 0 solid+border · 1 per-fess · 2 per-pale · 3 per-bend · 4 chevron.
     *  Omitted = keep the village's identity-derived pattern. */
    pattern?: number;
}

export const VILLAGE_BANNER_PALETTES = 8;
export const VILLAGE_BANNER_EMBLEMS = 6;
export const VILLAGE_BANNER_PATTERNS = 5;

/** Bounds-check an untrusted banner; null when it isn't a valid choice. */
export function sanitizeVillageBanner(raw: unknown): VillageBanner | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as { palette?: unknown; emblem?: unknown; pattern?: unknown };
    const palette = Number(record.palette);
    const emblem = Number(record.emblem);
    if (!Number.isInteger(palette) || palette < 0 || palette >= VILLAGE_BANNER_PALETTES) return null;
    if (!Number.isInteger(emblem) || emblem < 0 || emblem >= VILLAGE_BANNER_EMBLEMS) return null;
    const rawPattern = record.pattern === undefined || record.pattern === null ? undefined : Number(record.pattern);
    const pattern = rawPattern !== undefined && Number.isInteger(rawPattern) && rawPattern >= 0 && rawPattern < VILLAGE_BANNER_PATTERNS
        ? rawPattern
        : undefined;
    return pattern === undefined ? { palette, emblem } : { palette, emblem, pattern };
}

export function villageBannersEqual(a: VillageBanner | null | undefined, b: VillageBanner | null | undefined): boolean {
    if (!a || !b) return !a === !b;
    return a.palette === b.palette && a.emblem === b.emblem && (a.pattern ?? -1) === (b.pattern ?? -1);
}

export interface SerializedWorld {
    id: string; // Unique World ID
    ownerId: string; // 'player' or some enemy ID
    username?: string; // Owner's display name
    buildings: SerializedBuilding[];
    obstacles?: SerializedObstacle[]; // Optional for backward compat
    resources: PlayerResources;
    /** How much ore/food the layout can hold (base + storehouses). */
    storage?: { ore: number; food: number };
    population?: WorldPopulation; // Optional for backward compat
    /** Public resident authority used by postcards and attack snapshots. */
    life?: VillageLifeManifest;
    /** Owner-chosen heraldry (server-validated; ignored on save — use the
     *  banner mutation endpoint). Missing = identity-derived default. */
    banner?: VillageBanner;
    army?: Record<string, number>; // Persisted army state
    /** Server-computed paving age 0..1 (read-only; ignored on save). */
    stoneMaturity?: number;
    /** Owner-only: current trophy count so defense losses reach the HUD on
     *  the ordinary world poll (read-only; ignored on save). */
    trophies?: number;
    /** Server's effective upgrade-clock policy (fixed dev duration and/or
     *  time scale). The client derives every advertised duration from this —
     *  never from its own env (read-only; ignored on save). */
    upgradePolicy?: { fixedDurationMs?: number; timeScale?: number };
    wallLevel?: number; // Preferred level for new wall placements
    lastSaveTime: number;
    revision?: number;
}
