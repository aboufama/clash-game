import {
    BUILDING_DEFINITIONS,
    TROOP_DEFINITIONS,
    TROOP_FACTIONS,
    FACTION_BARRACKS,
    getTroopFaction,
    buildOreCostOf,
    upgradeOreCostOf,
    type BuildingType,
    type TroopFaction,
    type TroopType
} from './GameDefinitions';
import type { SerializedBuilding } from '../data/Models';
import { isHydrologyProtectedPlot } from './WorldHydrology';

/**
 * Shared economy math — imported by BOTH the server (charging, validation,
 * merchant pricing, bot loot) and the client (price badges, predictive HUD
 * accrual, merchant offers). If a price or rate lives anywhere else, one side
 * will eventually lie; add it here instead.
 */

// ---- deterministic randomness ----

export function hashString(s: string): number {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Small fast PRNG; same sequence for the same seed on server and client. */
export function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Calendar day on the shared world clock (server time; client corrects via serverOffsetMs). */
export function worldDayIndex(nowMs: number): number {
    return Math.floor(nowMs / 86_400_000);
}

// ---- production & storage (mirrored by the client for live HUD counters) ----

/** Per-second production split by what each building actually makes. */
export function productionRatesPerSecond(buildings: SerializedBuilding[]): { gold: number; ore: number; food: number } {
    const rates = { gold: 0, ore: 0, food: 0 };
    for (const building of buildings) {
        // A building mid-upgrade is offline: it produces nothing until the
        // server materializes the new level.
        if (building.upgradingTo) continue;
        const def = BUILDING_DEFINITIONS[building.type as BuildingType];
        if (!def) continue;
        const level = Math.max(1, Math.min(Math.floor(Number(building.level) || 1), def.maxLevel ?? 1));
        const levelStats = def.levels?.[level - 1];
        const rate = levelStats?.productionRate ?? def.productionRate ?? 0;
        if (rate <= 0) continue;
        if (def.produces === 'ore') rates.ore += rate;
        else if (def.produces === 'food') rates.food += rate;
        else rates.gold += rate;
    }
    return rates;
}

// Ore/food the village can hold before storehouses; each storage level adds more.
export const BASE_ORE_CAP = 150;
export const BASE_FOOD_CAP = 200;

export function resourceCapacity(buildings: SerializedBuilding[]): { ore: number; food: number } {
    let extra = 0;
    for (const building of buildings) {
        if (building.type !== 'storage') continue;
        const def = BUILDING_DEFINITIONS.storage;
        const level = Math.max(1, Math.min(Math.floor(Number(building.level) || 1), def.maxLevel ?? 1));
        extra += def.levels?.[level - 1]?.storageCapacity ?? 0;
    }
    return { ore: BASE_ORE_CAP + extra, food: BASE_FOOD_CAP + extra };
}

// ---- army ----

/** Housing contributed by one camp, sourced from the camp's level definitions. */
export function campHousingAtLevel(level: number): number {
    const def = BUILDING_DEFINITIONS.army_camp;
    const capped = Math.max(1, Math.min(Math.floor(Number(level) || 1), def.maxLevel ?? 1));
    return def.levels?.[capped - 1]?.capacity ?? def.capacity ?? 0;
}

/** Camp capacity: base 30, plus each camp's advertised level capacity, hard cap 150. */
export function campCapacityOf(buildings: SerializedBuilding[]): number {
    let total = 30;
    for (const building of buildings) {
        if (building.type !== 'army_camp') continue;
        total += campHousingAtLevel(building.level);
    }
    return Math.min(150, total);
}

export function armySpaceUsed(army: Record<string, number>): number {
    let used = 0;
    for (const [type, count] of Object.entries(army)) {
        const def = TROOP_DEFINITIONS[type as TroopType];
        if (!def) continue;
        used += def.space * Math.max(0, Math.floor(Number(count) || 0));
    }
    return used;
}

export type FactionBarracksLevels = Record<TroopFaction, number>;
// Keep the progression helpers available from this existing economy surface
// while their canonical definitions remain in the troop catalog barrel.
export {
    armyCampUnlockProgress,
    maxCompletedArmyCampLevel,
    type ArmyCampUnlockProgress
} from './definitions/TroopDefinitions';

/**
 * Highest ONLINE barracks level for every troop path. A building under
 * upgrade is a construction site and cannot train until the server completes
 * the shared upgrade interval.
 */
export function factionBarracksLevels(buildings: SerializedBuilding[]): FactionBarracksLevels {
    const levels: FactionBarracksLevels = { mystic: 0, mechanica: 0 };
    for (const faction of TROOP_FACTIONS) {
        const barracksType = FACTION_BARRACKS[faction];
        for (const building of buildings) {
            if (building.type !== barracksType || building.upgradingTo) continue;
            levels[faction] = Math.max(levels[faction], Math.floor(Number(building.level) || 1));
        }
    }
    return levels;
}

export function maxFactionBarracksLevel(buildings: SerializedBuilding[], faction: TroopFaction): number {
    return factionBarracksLevels(buildings)[faction];
}

export function barracksLevelForTroop(buildings: SerializedBuilding[], troopType: TroopType): number {
    const faction = getTroopFaction(troopType);
    return faction ? maxFactionBarracksLevel(buildings, faction) : 0;
}


/**
 * Troop level granted by the lab, mirroring the server rule (troopLevelOf in
 * server/domain/village/simulation.ts): a lab that is mid-upgrade is offline
 * and grants NOTHING, so troops drop to level 1 until the work lands.
 * Clamped to the 3 defined troop-level multipliers.
 */
export function effectiveTroopLevel(buildings: SerializedBuilding[]): number {
    let level = 1;
    for (const building of buildings) {
        if (building.type !== 'lab' || building.upgradingTo) continue;
        level = Math.max(level, Math.floor(Number(building.level) || 1));
    }
    return Math.max(1, Math.min(level, 3));
}

/** True when a lab upgrade is in flight — the moment troops read as level 1 server-side. */
export function labUpgradeInFlight(buildings: SerializedBuilding[]): boolean {
    return buildings.some(building => building.type === 'lab' && Boolean(building.upgradingTo));
}

// ---- building charges (what a save transaction owes) ----

function levelGoldCost(type: BuildingType, level: number): number {
    const def = BUILDING_DEFINITIONS[type];
    if (!def) return 0;
    return def.levels?.[level - 1]?.cost ?? def.cost;
}

/**
 * Price of a building arriving in a save at `level`. Legit clients place at
 * level 1 (walls at the cohort level); anything higher pays the full ladder,
 * so a forged high-level save costs exactly what honest play would have.
 */
export function placementCharge(type: BuildingType, level: number): { gold: number; ore: number } {
    const def = BUILDING_DEFINITIONS[type];
    if (!def) return { gold: 0, ore: 0 };
    const capped = Math.max(1, Math.min(Math.floor(level) || 1, def.maxLevel ?? 1));
    if (type === 'wall') {
        // A high-level segment paid the same ladder as an honestly upgraded
        // segment. Multiplying the L1 price by the level undercharged L4 by
        // almost 6x and made forged saves the cheapest way to buy walls.
        let gold = 0;
        let ore = 0;
        for (let step = 1; step <= capped; step++) {
            const stepGold = levelGoldCost(type, step);
            gold += stepGold;
            // Level 1 placement is deliberately ore-free. A wall arriving at
            // a higher cohort level must still pay every upgrade ore step.
            if (step > 1) ore += upgradeOreCostOf(stepGold);
        }
        return { gold, ore };
    }
    let gold = def.cost;
    let ore = buildOreCostOf(type, def.cost);
    for (let step = 2; step <= capped; step++) {
        const stepGold = levelGoldCost(type, step);
        gold += stepGold;
        ore += upgradeOreCostOf(stepGold);
    }
    return { gold, ore };
}

/** Price of raising an existing building from one level to a higher one. */
export function upgradeCharge(type: BuildingType, fromLevel: number, toLevel: number): { gold: number; ore: number } {
    const def = BUILDING_DEFINITIONS[type];
    if (!def) return { gold: 0, ore: 0 };
    const from = Math.max(1, Math.floor(fromLevel) || 1);
    const to = Math.max(from, Math.min(Math.floor(toLevel) || 1, def.maxLevel ?? 1));
    let gold = 0;
    let ore = 0;
    for (let step = from + 1; step <= to; step++) {
        const stepGold = levelGoldCost(type, step);
        gold += stepGold;
        ore += upgradeOreCostOf(stepGold);
    }
    return { gold, ore };
}

/** Demolition returns 80% of the current level's price (the client shows the same number). */
export function deleteRefundGold(type: BuildingType, level: number): number {
    return Math.floor(levelGoldCost(type, Math.max(1, Math.floor(level) || 1)) * 0.8);
}

/**
 * How long one upgrade step takes before the new level goes live, priced off
 * the step's gold cost so bigger works take longer. Walls are instant (the
 * cohort mechanic, CoC-style). The server sets the deadline from this; the
 * client uses the same number for its countdown estimate.
 */
export function upgradeDurationMs(type: BuildingType | string, toLevel: number): number {
    if (type === 'wall') return 0;
    const { gold } = upgradeCharge(type as BuildingType, Math.max(1, toLevel - 1), toLevel);
    return Math.min(2 * 3_600_000, 15_000 + gold * 200);
}

/** True while a building's server-owned upgrade clock is still running. */
export function isUpgrading(building: Pick<SerializedBuilding, 'upgradingTo' | 'upgradeEndsAt'>, now = Date.now()): boolean {
    return Boolean(building.upgradingTo && (building.upgradeEndsAt ?? 0) > now);
}

/**
 * World-map sight in plots. Without a watchtower a village sees only itself;
 * the tower's two levels open a 3x3 and then a 5x5 window (capped there so
 * the neighbourhood never gets heavy).
 */
export function watchtowerSightOf(buildings: SerializedBuilding[]): number {
    let level = 0;
    for (const b of buildings) {
        if (b.type === 'watchtower') level = Math.max(level, Math.floor(Number(b.level) || 1));
    }
    return Math.min(2, level);
}

// ---- raid loot ----

/** Share of a defender's stocks that a raid can carry off before protection. */
export const RAIDABLE_SHARE = 0.2;

/**
 * Storehouses shield part of the ore/food stocks from raids: 20% per
 * storehouse plus 5% per level above 1, capped at 60%. (Gold sits in the town
 * hall and is never shielded — defend it or lose it.)
 */
export function storehouseProtection(buildings: SerializedBuilding[]): number {
    let protection = 0;
    for (const building of buildings) {
        if (building.type !== 'storage') continue;
        const level = Math.max(1, Math.floor(Number(building.level) || 1));
        protection += 0.2 + 0.05 * (level - 1);
    }
    return Math.min(0.6, protection);
}

// ---- the travelling merchant (deterministic per player per world-day) ----

export interface MerchantOffer {
    id: number;
    give: { kind: 'gold' | 'ore' | 'food'; amount: number };
    get: { kind: 'gold' | 'ore' | 'food'; amount: number };
    /** Once-a-visit lucky deal, roughly double value. */
    bargain?: boolean;
    /** Each offer is one deal per visit; flipped by the UI once taken. */
    done?: boolean;
}

/**
 * The merchant's three trades for one player on one world-day. Pure function
 * of (playerKey, dayIndex): the client renders these and the server prices
 * them — a modified client cannot invent its own exchange rate.
 */
export function merchantOffersFor(playerKey: string, dayIndex: number): MerchantOffer[] {
    const rng = mulberry32(hashString(`${playerKey}:merchant:${dayIndex}`));
    const offers: MerchantOffer[] = [];
    const bargainAt = rng() < 0.16 ? Math.floor(rng() * 3) : -1;
    const scale = (base: number) => Math.round(base * (0.85 + rng() * 0.3));
    // Buy ore with gold
    const oreAmt = scale(50);
    offers.push({
        id: 1,
        give: { kind: 'gold', amount: bargainAt === 0 ? Math.round(oreAmt * 1.2) : Math.round(oreAmt * 2.4) },
        get: { kind: 'ore', amount: oreAmt },
        bargain: bargainAt === 0
    });
    // Buy food with gold
    const foodAmt = scale(70);
    offers.push({
        id: 2,
        give: { kind: 'gold', amount: bargainAt === 1 ? Math.round(foodAmt * 0.9) : Math.round(foodAmt * 1.8) },
        get: { kind: 'food', amount: foodAmt },
        bargain: bargainAt === 1
    });
    // Sell one of the stocks for gold
    const sellFood = rng() < 0.5;
    const sellAmt = scale(sellFood ? 60 : 45);
    offers.push({
        id: 3,
        give: { kind: sellFood ? 'food' : 'ore', amount: sellAmt },
        get: { kind: 'gold', amount: Math.round(sellAmt * (sellFood ? 1.0 : 1.3) * (bargainAt === 2 ? 2 : 1)) },
        bargain: bargainAt === 2
    });
    return offers;
}

// ---- the global bot map (shared so client raids and server settlement agree) ----

/**
 * Permanent wilderness preserves. Every three consecutive X and Y
 * coordinates contain this residue pair, so every earned 3x3 watchtower
 * window has a wild plot that bots and future player allocation cannot
 * consume. World-scale lake and river plots are protected by the same shared
 * predicate, keeping settlement, bots, and rendering on one geography. On
 * startup the server relocates any legacy occupant intact, so an upgrade
 * cannot leave a historical village consuming protected terrain.
 */
function generatedWorldSeedVersion(value: unknown): number {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return 0;
    return Math.min(0xffff_ffff, numeric);
}

export function isWildernessPreserveAt(x: number, y: number, rawSeedVersion: unknown = 0): boolean {
    if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
    const seedVersion = generatedWorldSeedVersion(rawSeedVersion);
    const mod3 = (value: number) => ((value % 3) + 3) % 3;
    // Preserve density and the "one wild plot in every 3x3" guarantee while
    // moving the protected residue in every generated-world epoch. Epoch zero
    // keeps the original (2,2) phase exactly for production compatibility.
    const preserveX = mod3(2 + seedVersion);
    const preserveY = mod3(2 + seedVersion + Math.floor(seedVersion / 3));
    return (mod3(x) === preserveX && mod3(y) === preserveY)
        || isHydrologyProtectedPlot(x, y, seedVersion);
}

/**
 * Which wilderness plots host a bot clan. Pure function of coordinates and
 * generated-world epoch, so every player sees the same current topology.
 * ~55% of non-preserve unowned plots; most of the origin ring is settled so a
 * new player's first horizon has both rival clans and permanent wilderness.
 */
export function botSeedAt(x: number, y: number, rawSeedVersion: unknown = 0): number | null {
    const seedVersion = generatedWorldSeedVersion(rawSeedVersion);
    if (isWildernessPreserveAt(x, y, seedVersion)) return null;
    if (x === 0 && y === 0) return null; // origin is the first player's home
    let h = (x * 374761393 + y * 668265263) ^ 0x5bf03635;
    if (seedVersion !== 0) {
        // Rotate both occupancy and the village seed. This is deliberately
        // before the avalanche rather than an appearance-only offset: a
        // reseed moves generated clans to different coordinates.
        h ^= Math.imul(seedVersion, 0x9e3779b9);
        h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    }
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = (h ^ (h >>> 16)) >>> 0;
    const near = Math.max(Math.abs(x), Math.abs(y)) <= 2;
    if (!near && h % 100 >= 55) return null;
    return seedVersion === 0 ? h : h === 0 ? 1 : h;
}

const BOT_CLANS = ['Ash', 'Briar', 'Crag', 'Dun', 'Elder', 'Fen', 'Gorse', 'Heath', 'Iron', 'Juniper', 'Kettle', 'Larch', 'Moss', 'Nettle', 'Oaken', 'Pyre'];
const BOT_SUFFIX = ['hollow', 'stead', 'wick', 'moor', 'shaw', 'garth', 'thorpe', 'field', 'crest', 'watch'];
// Plot-parity partition of the suffixes: the four (x&1, y&1) classes own
// DISJOINT suffix sets, and every plot in a plot's 8-neighbourhood lies in a
// different class than the plot itself — so two touching bot villages can
// never share a full name (seeds 1470536271/702915199 both hashed to
// 'Pyremoor' on side-by-side plots and read as one village spanning both).
const BOT_SUFFIX_BY_PARITY: ReadonlyArray<ReadonlyArray<number>> = [
    [0, 4, 8],
    [1, 5, 9],
    [2, 6],
    [3, 7]
];

export function botNameFor(seed: number, plotX?: number, plotY?: number): string {
    const clan = BOT_CLANS[seed % BOT_CLANS.length];
    if (plotX === undefined || plotY === undefined) {
        return `${clan}${BOT_SUFFIX[Math.floor(seed / 31) % BOT_SUFFIX.length]}`;
    }
    const set = BOT_SUFFIX_BY_PARITY[((plotX & 1) << 1) | (plotY & 1)];
    return `${clan}${BOT_SUFFIX[set[Math.floor(seed / 31) % set.length]]}`;
}

/** How long a raided bot camp rebuilds before it pays loot again. */
export const BOT_RAID_COOLDOWN_MS = 30 * 60_000;
