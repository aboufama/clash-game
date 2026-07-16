import React, { useEffect, useRef, useState } from 'react';
import { BUILDING_DEFINITIONS, type BuildingType, getBuildingStats, BARRACKS_TROOP_UNLOCK_ORDER, TROOP_DEFINITIONS, getTroopLevelMultiplier, upgradeOreCostOf } from '../game/config/GameDefinitions';
import { armySpaceUsed } from '../game/config/Economy';
import { serverUpgradeDurationMs } from '../game/config/UpgradePolicy';
import { gameManager } from '../game/GameManager';
import { BUILDING_TEXTS } from '../game/config/GameText';
import { defenseDps, getDefenseBehavior } from '../game/systems/DefenseBehaviorCatalog';
import { DayNightSystem } from '../game/systems/DayNightSystem';
import { formatGold } from '../game/economy/Currency';
import { IsoUtils } from '../game/utils/IsoUtils';
import { useWorldAnchor } from '../ui/useWorldAnchor';

interface InfoPanelProps {
    type: BuildingType;
    level: number;
    resources: { gold: number; ore: number; food?: number };
    /** Resource view used only for purchase eligibility (dev infinite mode). */
    spendableResources?: { gold: number; ore: number; food?: number };
    /** Village storage caps (ore/food) so storage buildings can show fill. */
    storageCaps?: { ore: number; food: number } | null;
    isExiting: boolean;
    onDelete: () => void;
    deleteDisabled?: boolean;
    deleteDisabledReason?: string;
    onUpgrade: () => void;
    onMove: () => void;
    upgradeCost?: number;
    isMobile?: boolean;
    gridX?: number;
    gridY?: number;
    /** Server-owned upgrade deadline (epoch ms); set while a work is running. */
    upgradeEndsAt?: number;
    /** Current effective village army capacity, already clamped to the global cap. */
    armyCapacity?: number;
}

/** "1h 05m" / "3m 24s" / "45s" — compact, single form per magnitude. */
function formatDuration(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
    if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
    return `${s}s`;
}

/**
 * The building speech bubble: a pixel-art popup pinned right above the
 * tapped building. Basic functions inline (upgrade with its price, move,
 * sell); the [i] corner expands the full stat sheet on demand. Replaces
 * the old right-side sliding panel.
 */
export const InfoPanel: React.FC<InfoPanelProps> = ({ type, level, resources, spendableResources = resources, storageCaps, isExiting, onDelete, deleteDisabled = false, deleteDisabledReason, onUpgrade, onMove, upgradeCost, isMobile = false, gridX, gridY, upgradeEndsAt, armyCapacity }) => {
    const [expanded, setExpanded] = useState(false);
    const bubbleRef = useRef<HTMLDivElement>(null);

    // Live countdown while the server's upgrade clock runs. The scene
    // re-emits the selection when the work lands, replacing this panel's
    // props with the finished level. The deadline is a SERVER epoch, so the
    // ticking clock must be server-corrected too (same offset the ambient
    // systems use) — raw Date.now() made the countdown drift by the skew.
    const serverNow = () => Date.now() + DayNightSystem.serverOffsetMs;
    const [now, setNow] = useState(serverNow);
    const upgrading = upgradeEndsAt !== undefined && upgradeEndsAt > now;
    useEffect(() => {
        if (upgradeEndsAt === undefined) return;
        setNow(serverNow());
        const timer = window.setInterval(() => setNow(serverNow()), 1000);
        return () => window.clearInterval(timer);
    }, [upgradeEndsAt]);

    const def = BUILDING_DEFINITIONS[type];
    // Anchor above the building's roofline (mirrors the health bar's offset).
    // The second point sits under the building's front vertex: useWorldAnchor
    // flips the bubble down there when it can't fit above (e.g. the [i] stat
    // sheet expanding on a building near the top of the screen).
    const anchor = def && gridX !== undefined && gridY !== undefined
        ? (() => {
            const p = IsoUtils.cartToIso(gridX + def.width / 2, gridY + def.height / 2);
            return { x: p.x, y: p.y - 42 - def.height * 11 };
        })()
        : null;
    const flipBelowY = def && gridX !== undefined && gridY !== undefined
        ? IsoUtils.cartToIso(gridX + def.width, gridY + def.height).y + 18
        : undefined;
    useWorldAnchor(bubbleRef, anchor, { clampMargin: { x: 170, top: 110, bottom: 70 }, flipBelowY });

    // A building type this client doesn't know (legacy data, version skew)
    // must never white-screen the app — the panel just doesn't open.
    if (!def) return null;
    const stats = getBuildingStats(type, level);
    const texts = BUILDING_TEXTS[type];

    const maxLevel = def.maxLevel || 1;
    const isMaxLevel = level >= maxLevel;
    const nextLevelStats = !isMaxLevel ? getBuildingStats(type, level + 1) : null;

    const finalCost = upgradeCost !== undefined ? upgradeCost : (nextLevelStats?.cost || 0);
    const oreCost = nextLevelStats ? upgradeOreCostOf(finalCost) : 0;
    const canAfford = nextLevelStats ? (spendableResources.gold >= finalCost && spendableResources.ore >= oreCost) : true;
    const upgradeDisabled = isMaxLevel || !canAfford || upgrading;
    // Advertised duration comes from the SERVER's policy (adopted off world
    // payloads), never from a client env var that can drift from the server.
    const nextDurationMs = !isMaxLevel ? serverUpgradeDurationMs(type, level + 1) : 0;

    const gain = (delta: string) => <span className="stat-gain">(+{delta})</span>;

    // Key attributes shown the moment the bubble opens — no [i] required.
    // Storage: how full each stock is. Army camp: how mustered the army is.
    const keyStats: { icon: string; label: string; value: number; cap: number }[] = [];
    if (type === 'storage' && storageCaps) {
        keyStats.push({ icon: 'ore-icon', label: 'ORE', value: Math.min(resources.ore, storageCaps.ore), cap: storageCaps.ore });
        keyStats.push({ icon: 'food-icon', label: 'FOOD', value: Math.min(resources.food ?? 0, storageCaps.food), cap: storageCaps.food });
    } else if (type === 'army_camp' && armyCapacity !== undefined && armyCapacity > 0) {
        keyStats.push({ icon: 'pop-icon', label: 'ARMY', value: Math.min(armySpaceUsed(gameManager.getArmy()), armyCapacity), cap: armyCapacity });
    }
    const rawHousingGain = Math.max(0, (nextLevelStats?.capacity ?? 0) - (stats.capacity ?? 0));
    const effectiveHousingGain = type === 'army_camp' && armyCapacity !== undefined
        ? Math.max(0, Math.min(150, armyCapacity + rawHousingGain) - armyCapacity)
        : rawHousingGain;

    return (
        <div
            ref={bubbleRef}
            className={`building-bubble ${anchor ? '' : 'unanchored'} ${isExiting ? 'exiting' : ''} ${isMobile ? 'mobile' : ''}`}
        >
            <div className="bb-header">
                <span className={`icon ${type}-icon bb-icon`} />
                <span className="bb-name">{def.name.toUpperCase()}</span>
                <span className="bb-level">LV {level}</span>
                <button
                    className={`bb-info-toggle ${expanded ? 'pxf-pressed' : ''}`}
                    title={expanded ? 'Less' : 'Details'}
                    onClick={() => setExpanded(v => !v)}
                >
                    <span className="icon info-i-icon" />
                </button>
            </div>

            {keyStats.length > 0 && (
                <div className="bb-keystats">
                    {keyStats.map(ks => (
                        <div className="bb-keystat" key={ks.label}>
                            <span className={`icon ${ks.icon}`} />
                            <span className="bb-keybar"><i style={{ width: `${Math.round((ks.cap > 0 ? ks.value / ks.cap : 0) * 100)}%` }} /></span>
                            <span className="bb-keyvalue">{formatGold(ks.value, false, false)}/{formatGold(ks.cap, false, false)}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="bb-actions">
                {type === 'jukebox' && (
                    <button
                        className="bb-btn"
                        title="Open the track list"
                        onClick={() => gameManager.openJukebox()}
                    >
                        <span>TRACKS</span>
                    </button>
                )}
                {type === 'town_hall' && (
                    <button
                        className="bb-btn"
                        title="Choose your village banner"
                        onClick={() => gameManager.openBannerPicker()}
                    >
                        <span>BANNER</span>
                    </button>
                )}
                <button
                    className={`bb-btn upgrade ${upgradeDisabled ? 'disabled' : ''} ${isMaxLevel ? 'maxed' : ''} ${upgrading ? 'working' : ''}`}
                    disabled={upgradeDisabled}
                    onClick={onUpgrade}
                >
                    {isMaxLevel ? <span className="bb-max">MAX</span> : upgrading ? (
                        <>
                            <span>UPGRADING</span>
                            <span className="bb-cost bb-timer">{formatDuration(upgradeEndsAt! - now)}</span>
                        </>
                    ) : (
                        <>
                            <span>UPGRADE</span>
                            <span className={`bb-cost ${canAfford ? 'ok' : 'short'}`}>
                                <span className="icon gold-icon" />
                                {formatGold(finalCost, false, false)}
                                {oreCost > 0 && (
                                    <>
                                        <span className="icon ore-icon" />
                                        {formatGold(oreCost, false, false)}
                                    </>
                                )}
                                {nextDurationMs > 0 && (
                                    <span className="bb-duration">~{formatDuration(nextDurationMs)}</span>
                                )}
                            </span>
                        </>
                    )}
                </button>
                <button className="bb-btn" onClick={onMove} title={isMobile ? 'Move' : 'Move (M)'}>
                    <span className="icon move-icon" />
                </button>
                {type !== 'town_hall' && (
                    <button
                        className={`bb-btn danger ${deleteDisabled ? 'disabled' : ''}`}
                        onClick={onDelete}
                        disabled={deleteDisabled}
                        title={deleteDisabled ? deleteDisabledReason : 'Sell'}
                    >
                        <span className="icon delete-icon" />
                    </button>
                )}
            </div>

            {expanded && (
                <div className="bb-details">
                    {texts?.flavor && <div className="bb-flavor">{texts.flavor}</div>}
                    <div className="stat-row">
                        <span className="stat-label">Health</span>
                        <span className="stat-value">
                            {stats.maxHealth}
                            {nextLevelStats && nextLevelStats.maxHealth > stats.maxHealth && gain(String(nextLevelStats.maxHealth - stats.maxHealth))}
                        </span>
                    </div>
                    {stats.damage && (
                        <div className="stat-row">
                            <span className="stat-label">Damage</span>
                            <span className="stat-value">
                                {stats.damage}
                                {nextLevelStats?.damage && nextLevelStats.damage > stats.damage && gain(String(nextLevelStats.damage - stats.damage))}
                            </span>
                        </div>
                    )}
                    {stats.fireRate && getDefenseBehavior(type)?.fireModel.kind !== 'dps' && (
                        <div className="stat-row">
                            <span className="stat-label">Speed</span>
                            <span className="stat-value">{(stats.fireRate / 1000).toFixed(1)}s</span>
                        </div>
                    )}
                    {(() => {
                        // Derived from the fire model (tick beams, salvo
                        // batteries) — never damage × rate recomputed here.
                        const dps = defenseDps(type, stats);
                        return dps !== null && (
                            <div className="stat-row">
                                <span className="stat-label">DPS</span>
                                <span className="stat-value">{Math.round(dps)}</span>
                            </div>
                        );
                    })()}
                    {stats.range && (
                        <div className="stat-row">
                            <span className="stat-label">Range</span>
                            <span className="stat-value">{stats.range}</span>
                        </div>
                    )}
                    {stats.productionRate && (
                        <div className="stat-row">
                            <span className="stat-label">Production</span>
                            <span className="stat-value">
                                {stats.productionRate}/s
                                {/* Rates carry 2 decimals (0.09 → 0.14): a 1-decimal
                                    gain rounds +0.05 up to +0.1 — double the truth. */}
                                {nextLevelStats?.productionRate && nextLevelStats.productionRate > stats.productionRate && gain(String(parseFloat((nextLevelStats.productionRate - stats.productionRate).toFixed(2))))}
                            </span>
                        </div>
                    )}
                    {stats.capacity && (
                        <div className="stat-row">
                            <span className="stat-label">Housing</span>
                            <span className="stat-value">
                                +{stats.capacity}
                                {effectiveHousingGain > 0 && gain(String(effectiveHousingGain))}
                                {rawHousingGain > 0 && effectiveHousingGain === 0 && (
                                    <span className="stat-gain">(VILLAGE CAP REACHED)</span>
                                )}
                            </span>
                        </div>
                    )}
                    {type === 'barracks' && level <= BARRACKS_TROOP_UNLOCK_ORDER.length && (
                        <div className="stat-row">
                            <span className="stat-label">Trains</span>
                            <span className="stat-value">{TROOP_DEFINITIONS[BARRACKS_TROOP_UNLOCK_ORDER[level - 1]]?.name ?? '—'}</span>
                        </div>
                    )}
                    {type === 'barracks' && !isMaxLevel && level < BARRACKS_TROOP_UNLOCK_ORDER.length && (
                        <div className="stat-row">
                            <span className="stat-label">Next</span>
                            <span className="stat-value next">{TROOP_DEFINITIONS[BARRACKS_TROOP_UNLOCK_ORDER[level]]?.name ?? '—'}</span>
                        </div>
                    )}
                    {type === 'lab' && (
                        <div className="stat-row">
                            <span className="stat-label">Troop Stats</span>
                            <span className="stat-value">{getTroopLevelMultiplier(level)}x</span>
                        </div>
                    )}
                    {texts?.details && <div className="bb-more">{texts.details}</div>}
                </div>
            )}
            <span className="px-tail" />
        </div>
    );
};
