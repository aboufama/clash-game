
import type { SerializedBuilding } from '../data/Models';
import { RAIDABLE_SHARE, storehouseProtection } from '../config/Economy';

export interface BuildingLoot {
    gold: number;
    ore: number;
    food: number;
}

export class LootSystem {
    /**
     * The capped raidable pools for a battle — the SAME math the server uses
     * to build its lootCaps at attack start (attack-service.ts): raidable
     * share of the defender's stocks, with storehouse protection on ore/food.
     * PvP attack snapshots already contain server-capped totals
     * (`preCapped`); bot worlds contain raw stocks and still need the normal
     * share/protection calculation here.
     *
     * The in-battle HUD counter is `pool × destruction%` (mirroring the
     * server settlement's `lootCaps × destruction / 100`), NOT a per-building
     * split — the old distribution model drifted from the real payout.
     */
    public static calculateRaidablePools(
        buildings: SerializedBuilding[],
        totalGold: number,
        totalOre: number = 0,
        totalFood: number = 0,
        preCapped: boolean = false
    ): BuildingLoot {
        const protection = preCapped ? 0 : storehouseProtection(buildings);
        const share = preCapped ? 1 : RAIDABLE_SHARE;
        return {
            gold: Math.floor(Math.max(0, totalGold) * share),
            ore: Math.floor(Math.max(0, totalOre) * share * (1 - protection)),
            food: Math.floor(Math.max(0, totalFood) * share * (1 - protection))
        };
    }
}
