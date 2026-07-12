
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
    army?: Record<string, number>; // Persisted army state
    /** Server-computed paving age 0..1 (read-only; ignored on save). */
    stoneMaturity?: number;
    wallLevel?: number; // Preferred level for new wall placements
    lastSaveTime: number;
    revision?: number;
}
