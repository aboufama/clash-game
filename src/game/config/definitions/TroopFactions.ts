/**
 * The two player troop progression paths. Keep faction identity and its
 * training building in this Phaser-free catalog so the React client and both
 * server runtimes make the same unlock decision.
 */
export const TROOP_FACTIONS = ['mystic', 'mechanica'] as const;

export type TroopFaction = typeof TROOP_FACTIONS[number];

/**
 * `barracks` remains the internal id of the original building so existing
 * villages migrate in place: it is now the Mechanica Barracks. Mystic keeps
 * its dedicated building; the removed Biopunk path and building self-clean
 * from old villages through the shared building catalog.
 */
export const FACTION_BARRACKS = {
    mystic: 'mystic_barracks',
    mechanica: 'barracks'
} as const satisfies Record<TroopFaction, string>;

export type FactionBarracksType = typeof FACTION_BARRACKS[TroopFaction];

export const FACTION_BARRACKS_TYPES = TROOP_FACTIONS.map(
    faction => FACTION_BARRACKS[faction]
) as readonly FactionBarracksType[];

export interface TroopFactionMeta {
    id: TroopFaction;
    name: string;
    shortName: string;
    description: string;
    barracksType: FactionBarracksType;
    barracksName: string;
    /** CSS-friendly accent for the training tree; gameplay never reads it. */
    accent: string;
}

export const TROOP_FACTION_META = {
    mystic: {
        id: 'mystic',
        name: 'Mystic',
        shortName: 'Mystic',
        description: 'harnessing the arcane',
        barracksType: FACTION_BARRACKS.mystic,
        barracksName: 'Mystic Barracks',
        accent: '#9d7bea'
    },
    mechanica: {
        id: 'mechanica',
        name: 'Mechanica',
        shortName: 'Mechanica',
        description: 'engineering the impossible',
        barracksType: FACTION_BARRACKS.mechanica,
        barracksName: 'Mechanica Barracks',
        accent: '#d58a3d'
    }
} as const satisfies Record<TroopFaction, TroopFactionMeta>;

export function isTroopFaction(value: string): value is TroopFaction {
    return (TROOP_FACTIONS as readonly string[]).includes(value);
}

export function isFactionBarracksType(value: string): value is FactionBarracksType {
    return (FACTION_BARRACKS_TYPES as readonly string[]).includes(value);
}

export function factionForBarracks(type: string): TroopFaction | null {
    for (const faction of TROOP_FACTIONS) {
        if (FACTION_BARRACKS[faction] === type) return faction;
    }
    return null;
}
