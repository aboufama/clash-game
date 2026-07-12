
import type { SerializedBuilding } from '../data/Models';
import { RAIDABLE_SHARE, storehouseProtection } from '../config/Economy';

export interface BuildingLoot {
    gold: number;
    ore: number;
    food: number;
}

export class LootSystem {
    /**
     * Split raidable wealth across its visible holders: gold sits in the town
     * hall, ore in mines/storehouses, and food in farms/storehouses. PvP attack
     * snapshots already contain server-capped totals; bot worlds contain raw
     * stocks and still need the normal share/protection calculation here.
     */
    public static calculateLootDistribution(
        buildings: SerializedBuilding[],
        totalGold: number,
        totalOre: number = 0,
        totalFood: number = 0,
        preCapped: boolean = false
    ): Map<string, BuildingLoot> {
        const lootMap = new Map<string, BuildingLoot>();
        const protection = preCapped ? 0 : storehouseProtection(buildings);
        const share = preCapped ? 1 : RAIDABLE_SHARE;
        const raidableGold = Math.floor(Math.max(0, totalGold) * share);
        const raidableOre = Math.floor(Math.max(0, totalOre) * share * (1 - protection));
        const raidableFood = Math.floor(Math.max(0, totalFood) * share * (1 - protection));

        const townHalls = buildings.filter(b => b.type === 'town_hall');
        const oreHolds = buildings.filter(b => b.type === 'mine' || b.type === 'storage');
        const foodHolds = buildings.filter(b => b.type === 'farm' || b.type === 'storage');

        const grant = (targets: SerializedBuilding[], kind: keyof BuildingLoot, amount: number) => {
            // No dedicated holder? The town hall keeps the overflow.
            const hosts = targets.length > 0 ? targets : townHalls;
            if (hosts.length === 0 || amount <= 0) return;
            const per = Math.floor(amount / hosts.length);
            const remainder = amount % hosts.length;
            for (let i = 0; i < hosts.length; i++) {
                const b = hosts[i];
                const portion = per + (i < remainder ? 1 : 0);
                if (portion <= 0) continue;
                const entry = lootMap.get(b.id) ?? { gold: 0, ore: 0, food: 0 };
                entry[kind] += portion;
                lootMap.set(b.id, entry);
            }
        };

        grant(townHalls, 'gold', raidableGold);
        grant(oreHolds, 'ore', raidableOre);
        grant(foodHolds, 'food', raidableFood);

        return lootMap;
    }
}
