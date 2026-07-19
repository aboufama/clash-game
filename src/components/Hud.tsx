import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BuildingType, TroopType } from '../game/config/GameDefinitions';
import { TROOP_DEFINITIONS } from '../game/config/GameDefinitions';
import type { GameMode } from '../game/types/GameMode';
import { formatGold } from '../game/economy/Currency';
import { soundSystem } from '../game/systems/SoundSystem';
import { InfoPanel } from './InfoPanel';
import { TroopIcon } from './TroopIcon';

const INFINITE_RESOURCE_DISPLAY = '999,999';

interface BattleStats {
  destruction: number;
  goldLooted: number;
  oreLooted?: number;
  foodLooted?: number;
}

interface HudProps {
  view: GameMode;
  resources: { gold: number; ore: number; food: number };
  /** Funds used only by affordability checks; authoritative balances stay finite. */
  spendableResources: { gold: number; ore: number; food: number };
  infiniteResources: boolean;
  storageCaps: { ore: number; food: number } | null;
  population: { count: number; capacity: number; workersNeeded: number; staffing: number };
  battleStats: BattleStats;
  battleStarted: boolean;
  visibleTroops: string[];
  selectedTroopType: string;
  army: Record<string, number>;
  armyCapacity: number;
  selectedBuildingInfo: { id: string; type: BuildingType; level: number; gridX?: number; gridY?: number; upgradeEndsAt?: number } | null;
  isExiting: boolean;
  wallUpgradeCostOverride?: number;
  isMobile: boolean;
  isScouting: boolean;
  pendingLoot: number | null;
  lootAnimating: { amount: number } | null;
  onLootAnimationDone: () => void;
  onOpenSettings: () => void;
  onOpenBuild: () => void;
  onOpenTrain: () => void;
  onSelectTroop: (type: string) => void;
  onNextMap: () => void;
  onGoHome: () => void;
  onDeleteBuilding: () => void;
  deleteBuildingDisabled?: boolean;
  deleteBuildingDisabledReason?: string;
  onUpgradeBuilding: () => void;
  onMoveBuilding: () => void;
  onOpenMap: () => void;
  troopLevel: number;
}

export function Hud({
  view,
  resources,
  spendableResources,
  infiniteResources,
  storageCaps,
  population,
  battleStats,
  battleStarted,
  visibleTroops,
  selectedTroopType,
  army,
  armyCapacity,
  selectedBuildingInfo,
  isExiting,
  wallUpgradeCostOverride,
  isMobile,
  isScouting,
  pendingLoot,
  lootAnimating,
  onLootAnimationDone,
  onOpenSettings,
  onOpenBuild,
  onOpenTrain,
  onSelectTroop,
  onNextMap,
  onGoHome,
  onDeleteBuilding,
  deleteBuildingDisabled,
  deleteBuildingDisabledReason,
  onUpgradeBuilding,
  onMoveBuilding,
  onOpenMap,
  troopLevel
}: HudProps) {
  // Get troop name for mobile display
  const getTroopName = (type: string): string => {
    const def = TROOP_DEFINITIONS[type as TroopType];
    return def?.name || type;
  };
  const isAttackView = view === 'ATTACK';
  const showAttackTroopBar = isAttackView && !(isScouting && visibleTroops.length === 0);

  const [isMuted, setIsMuted] = useState(soundSystem.muted);

  // The settings modal has the same mute switch; it announces changes via
  // 'clash:muted' so this speaker button never goes stale.
  useEffect(() => {
    const sync = () => setIsMuted(soundSystem.muted);
    window.addEventListener('clash:muted', sync);
    return () => window.removeEventListener('clash:muted', sync);
  }, []);

  // Auto-dismiss hotkey hint
  const [showHotkeyHint, setShowHotkeyHint] = useState(true);
  useEffect(() => {
    if (view !== 'ATTACK' || isMobile) return;
    setShowHotkeyHint(true);
    const timer = setTimeout(() => setShowHotkeyHint(false), 6000);
    return () => clearTimeout(timer);
  }, [view, isMobile]);

  // Number keys (1-9, 0) select troops in the battle bar
  useEffect(() => {
    if (view !== 'ATTACK' || !showAttackTroopBar || isMobile) return;
    const handler = (e: KeyboardEvent) => {
      // Ignore if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = e.key;
      if (key >= '1' && key <= '9') {
        const idx = parseInt(key) - 1;
        if (idx < visibleTroops.length) {
          const t = visibleTroops[idx];
          if (army[t] > 0) onSelectTroop(t);
        }
      } else if (key === '0' && visibleTroops.length >= 10) {
        const t = visibleTroops[9];
        if (army[t] > 0) onSelectTroop(t);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [view, showAttackTroopBar, isMobile, visibleTroops, army, onSelectTroop]);

  // Whether we're showing loot (either pending on clouds or counting up)
  const showingLoot = pendingLoot !== null || lootAnimating !== null;
  const lootAmount = lootAnimating?.amount ?? pendingLoot ?? 0;

  // Count-up animation for resource display
  const [displaySol, setDisplaySol] = useState(resources.gold);
  const [isBouncing, setIsBouncing] = useState(false);
  const [isFadingLoot, setIsFadingLoot] = useState(false);
  const animFrameRef = useRef<number>(0);
  const lootDoneTimerRef = useRef<number | undefined>(undefined);

  // Keep displaySol in sync when not animating
  useEffect(() => {
    if (!lootAnimating) {
      setDisplaySol(resources.gold);
    }
  }, [resources.gold, lootAnimating]);

  // The count-up base is frozen at animation start (read through a ref):
  // a world sync landing mid-animation must not restart the tally, and a
  // server reconciling DOWN must never start it below zero.
  const goldRef = useRef(resources.gold);
  useEffect(() => {
    goldRef.current = resources.gold;
  }, [resources.gold]);

  // Count-up effect when loot animation triggers (clouds finished opening)
  useEffect(() => {
    if (!lootAnimating) {
      setIsFadingLoot(false);
      return;
    }

    const endSol = Math.max(0, goldRef.current);
    const startSol = Math.max(0, endSol - lootAnimating.amount);
    const duration = 800;
    let startTime: number | null = null;

    setDisplaySol(startSol);
    setIsBouncing(true);
    setIsFadingLoot(false);

    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplaySol(Math.round(startSol + (endSol - startSol) * eased));

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(animate);
      } else {
        setIsBouncing(false);
        setIsFadingLoot(true);
        lootDoneTimerRef.current = window.setTimeout(() => onLootAnimationDone(), 600);
      }
    };

    animFrameRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animFrameRef.current);
      if (lootDoneTimerRef.current) window.clearTimeout(lootDoneTimerRef.current);
      setIsBouncing(false);
    };
  }, [lootAnimating]);

  // The resources column. While loot is showing it is PORTALED to <body>:
  // .hud's z-index traps children in its stacking context, so no child
  // z-index can ever climb above the cloud overlay from inside it. The
  // portal wrapper re-applies the .hud classes so the mobile descendant
  // rules keep styling the chips.
  const resourcesColumn = (
    <div className={`resources ${showingLoot ? 'over-clouds' : ''}`}>
      <div className="res-row">
        <div className={`res-item gold ${isBouncing ? 'bounce' : ''}`}>
          <span className="icon gold-icon" />
          <span>{infiniteResources ? INFINITE_RESOURCE_DISPLAY : formatGold(displaySol, isMobile, false)}</span>
        </div>
        {showingLoot && lootAmount > 0 && (
          <span className={`loot-badge ${isFadingLoot ? 'fading' : ''}`}>
            +{formatGold(lootAmount, false, false)}
          </span>
        )}
      </div>
      <div className="res-row">
        <div className="res-item ore">
          <span className="icon ore-icon" />
          <span>{infiniteResources ? INFINITE_RESOURCE_DISPLAY : formatGold(resources.ore, isMobile, false)}</span>
        </div>
      </div>
      <div className="res-row">
        <div className="res-item food">
          <span className="icon food-icon" />
          <span>{infiniteResources ? INFINITE_RESOURCE_DISPLAY : formatGold(resources.food, isMobile, false)}</span>
        </div>
      </div>
      <div className="res-row">
        <div
          className={`res-item pop ${population.staffing < 1 ? 'understaffed' : ''}`}
          title={population.staffing < 1
            ? `Understaffed: ${population.count}/${population.workersNeeded} workers — mines and farms run at ${Math.round(population.staffing * 100)}%`
            : 'Population'}
        >
          <span className="icon pop-icon" />
          <span>{population.count}/{population.capacity}</span>
          {population.staffing < 1 && <span className="pop-warn">!</span>}
        </div>
      </div>
    </div>
  );

  return (
    <div className={`hud ${isMobile ? 'mobile' : ''}`}>
      <div className="hud-top">
        {view === 'HOME' ? (
          <>
            {showingLoot
              ? createPortal(
                <div className={`hud ${isMobile ? 'mobile' : ''} hud-loot-layer`}>
                  {resourcesColumn}
                </div>,
                document.body
              )
              : resourcesColumn}
            <div className="top-btn-stack">
              <button className="settings-btn" onClick={() => { soundSystem.play('uiOpen'); onOpenSettings(); }}>
                <div className="btn-icon icon settings-icon"></div>
              </button>
              <button
                className={`settings-btn mute-btn ${isMuted ? 'muted' : ''}`}
                title={isMuted ? 'Unmute' : 'Mute'}
                onClick={() => {
                  const next = !isMuted;
                  soundSystem.setMuted(next);
                  setIsMuted(next);
                }}
              >
                <span className={`sym ${isMuted ? 'sym-speaker-off' : 'sym-speaker'}`} />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* ATTACK only — one event, one surface: while spectating
                (REPLAY view) the destruction lives inside the single
                replay-status-overlay card in App.tsx, never as a second
                stacked HUD row. */}
            {battleStarted && isAttackView && (
              <>
                <div className="battle-stats">
                  <div className="destruction-meter">
                    <div className="destruction-bar">
                      <div className="destruction-fill" style={{ width: `${battleStats.destruction}%` }}></div>
                    </div>
                    <span className="destruction-text">{battleStats.destruction}%</span>
                  </div>
                </div>
                <div className="loot-display">
                  <div className="loot-item gold">
                    <span className="icon gold-icon" />
                    <span>+{formatGold(battleStats.goldLooted, isMobile, false)}</span>
                  </div>
                  {(battleStats.oreLooted ?? 0) > 0 && (
                    <div className="loot-item ore">
                      <span className="icon ore-icon" />
                      <span>+{battleStats.oreLooted}</span>
                    </div>
                  )}
                  {(battleStats.foodLooted ?? 0) > 0 && (
                    <div className="loot-item food">
                      <span className="icon food-icon" />
                      <span>+{battleStats.foodLooted}</span>
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>

      {selectedBuildingInfo && view === 'HOME' && (
        <InfoPanel
          type={selectedBuildingInfo.type}
          level={selectedBuildingInfo.level}
          gridX={selectedBuildingInfo.gridX}
          gridY={selectedBuildingInfo.gridY}
          upgradeEndsAt={selectedBuildingInfo.upgradeEndsAt}
          resources={resources}
          spendableResources={spendableResources}
          storageCaps={storageCaps}
          armyCapacity={armyCapacity}
          isExiting={isExiting}
          onDelete={onDeleteBuilding}
          deleteDisabled={deleteBuildingDisabled}
          deleteDisabledReason={deleteBuildingDisabledReason}
          onUpgrade={onUpgradeBuilding}
          onMove={onMoveBuilding}
          upgradeCost={wallUpgradeCostOverride}
          key={selectedBuildingInfo.id}
          isMobile={isMobile}
        />
      )}

      {(view === 'HOME' || showAttackTroopBar) && (
        <div className="build-menu">
          {view === 'HOME' ? (
          <div className="menu-inner">
            <div className="btn-group main-actions">
              <button className="action-btn build" onClick={() => { soundSystem.play('uiOpen'); onOpenBuild(); }}>
                <div className="btn-icon icon build-icon"></div>
                <span className="btn-label">{isMobile ? '' : 'BUILD'}</span>
              </button>
              <button className="action-btn raid" onClick={() => { soundSystem.play('uiOpen'); onOpenTrain(); }}>
                <div className="btn-icon icon raid-icon"></div>
                <span className="btn-label">{isMobile ? '' : 'RAID'}</span>
              </button>
              <button className="action-btn map" onClick={() => { soundSystem.play('uiOpen'); onOpenMap(); }}>
                <div className="btn-icon icon map-icon"></div>
                <span className="btn-label">{isMobile ? '' : 'MAP'}</span>
              </button>
            </div>
          </div>
          ) : (
            <div className="menu-inner raid">
              <div className={`troop-selector ${isMobile ? 'mobile-troop-selector' : ''}`}>
                {visibleTroops.map(t => {
                  const count = army[t];
                  return (
                    <button
                      key={t}
                      className={`troop-sel-btn ${t} ${selectedTroopType === t ? 'active' : ''} ${count <= 0 ? 'disabled' : ''}`}
                      disabled={count <= 0}
                      onClick={() => { if (count > 0) { soundSystem.play('uiTap'); onSelectTroop(t); } }}
                    >
                      <TroopIcon type={t} />
                      <span className="troop-count-badge">{count}</span>
                      {troopLevel > 1 && <span className="troop-level-badge">Lv{troopLevel}</span>}
                      {isMobile && selectedTroopType === t && (
                        <span className="mobile-troop-name">{getTroopName(t)}</span>
                      )}
                    </button>
                  );
                })}
              </div>
              {!isMobile && visibleTroops.length > 0 && showHotkeyHint && (
                <div className="troop-hotkey-hint">Use number keys to switch troops</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Mobile floating action buttons for ATTACK mode */}
      {view === 'ATTACK' && isMobile && (
        <>
          <button
            className={`mobile-action-btn home-btn ${battleStarted ? 'battle-active' : ''}`}
            onClick={() => { soundSystem.play('uiTap'); onGoHome(); }}
          >
            <div className="icon home-icon"></div>
          </button>
          {!battleStarted && (
            <button className="mobile-action-btn next-btn" onClick={() => { soundSystem.play('uiTap'); onNextMap(); }}>
              <div className="icon findmatch-icon"></div>
            </button>
          )}
        </>
      )}

      {/* Desktop scout/home panels */}
      {view === 'ATTACK' && !battleStarted && !isMobile && (
        <div className="scout-panel">
          <button className="action-btn next-map" onClick={() => { soundSystem.play('uiTap'); onNextMap(); }}>
            <div className="btn-icon icon findmatch-icon"></div>
            <span className="btn-label">NEXT</span>
          </button>
        </div>
      )}

      {view === 'ATTACK' && !isMobile && (
        <div className="home-panel">
          <button className="action-btn home" onClick={() => { soundSystem.play('uiTap'); onGoHome(); }}>
            <div className="btn-icon icon home-icon"></div>
            <span className="btn-label">HOME</span>
          </button>
        </div>
      )}
    </div>
  );
}

// formatGold handles compact formatting for mobile.
