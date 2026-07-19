import { useRef, useState } from 'react';
import type { TroopDef, TroopFaction, TroopType } from '../game/config/GameDefinitions';
import { CORE_TROOP_TYPES, TROOP_FACTIONS, TROOP_FACTION_META, TROOP_TECH_TREES, getCoreTroopUnlockLevel, getTroopStats, getTroopUnlockLevel, troopFoodCostOf } from '../game/config/GameDefinitions';
import { formatGold } from '../game/economy/Currency';
import { soundSystem } from '../game/systems/SoundSystem';
import type { FactionBarracksLevels } from '../game/config/Economy';
import { TroopIcon } from './TroopIcon';

const TROOP_FLAVOR: Record<string, string> = {
    warrior: 'A dependable close-range fighter and the foundation of every army.',
    archer: 'A ranged fighter who attacks safely from behind the line.',
    physicianscart: "A mobile healer that restores nearby allies from a physician's cart.",
    phalanx: 'A runic shield formation that releases nine Bound Spirits on death.',
    wallbreaker: 'Volatile Emberling that races to walls and erupts on impact.',
    goblinplunderer: 'Greedy sprinter that hits resource buildings 3x harder. Terrible in a fight.',
    clockworkbeetle: 'Wind-up bomb that scuttles to the nearest building and pops.',
    stormmage: 'Chain lightning hits up to 4 targets per strike.',
    mobilemortar: 'Sets up and lobs splash damage shells from long range.',
    siegetower: 'Rolling belfry that parks at a wall and ramps your army over it.',
    golem: 'Massive stone titan. Nearly indestructible, targets defenses.',
    icegolem: 'Frozen colossus. Lighter than stone but slams faster.',
    necromancer: 'Raises skeletons from the battlefield while blasting from range.',
    trebuchet: 'Counterweight artillery that outranges every defense but one.',
    davincitank: "Armored war machine that fires cannons in all directions.",
    warelephant: 'Armored titan that tramples straight through walls.',
    ornithopter: "Da Vinci's flying machine. Soars over walls and bombs defenses.",
};

interface TrainingModalProps {
  isOpen: boolean;
  showCloudOverlay: boolean;
  capacity: { current: number; max: number };
  resources: { gold: number; food: number };
  army: Record<string, number>;
  troops: TroopDef[];
  troopLevel: number;
  /** True while a lab upgrade runs: the server treats troops as level 1, so the badge explains the drop. */
  troopLevelUpgrading?: boolean;
  /** Highest ONLINE barracks level in each independent troop path. */
  barracksLevels: FactionBarracksLevels;
  /** Per path, true when its barracks exists but is temporarily a construction site. */
  barracksUpgrading: Record<TroopFaction, boolean>;
  /** Highest completed Army Camp level. Core troops unlock one per camp level. */
  armyCampLevel: number;
  /** True while at least one Army Camp is temporarily a construction site. */
  armyCampUpgrading: boolean;
  /** Highest in-flight Army Camp target level, when an upgrade is running. */
  armyCampUpgradingToLevel: number | null;
  onClose: () => void;
  onStartPractice: () => void;
  onFindMatch: () => void;
  onTrainTroop: (type: string) => void | Promise<void>;
  onUntrainTroop: (type: string) => void | Promise<void>;
}

interface TooltipInfo {
  id: string;
  x: number;
  y: number;
}

export function TrainingModal({
  isOpen,
  showCloudOverlay,
  capacity,
  resources,
  army,
  troops,
  troopLevel,
  troopLevelUpgrading = false,
  barracksLevels,
  barracksUpgrading,
  armyCampLevel,
  armyCampUpgrading,
  armyCampUpgradingToLevel,
  onClose,
  onStartPractice,
  onFindMatch,
  onTrainTroop,
  onUntrainTroop
}: TrainingModalProps) {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  if (!isOpen) return null;

  const handleMouseEnter = (troopId: string, e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setTooltip({
      id: troopId,
      x: rect.left + rect.width / 2,
      y: rect.top
    });
  };

  const handleMouseLeave = () => setTooltip(null);

  const tooltipTroop = tooltip ? troops.find(t => t.id === tooltip.id) : null;
  const tooltipScaled = tooltipTroop ? getTroopStats(tooltipTroop.id as TroopType, troopLevel) : null;
  const tooltipFlavor = tooltipTroop ? (TROOP_FLAVOR[tooltipTroop.id] || tooltipTroop.desc) : '';

  const renderTroopCard = ({
    troopId,
    label,
    isLocked = false,
    lockText = '',
    isFlagship = false,
    isCore = false
  }: {
    troopId: TroopType;
    label?: string;
    isLocked?: boolean;
    lockText?: string;
    isFlagship?: boolean;
    isCore?: boolean;
  }) => {
    const troop = troops.find(candidate => candidate.id === troopId);
    if (!troop) return null;

    const foodCost = troopFoodCostOf(troop.id as TroopType);
    const canAfford = resources.gold >= troop.cost;
    const hasFood = resources.food >= foodCost;
    const hasSpace = capacity.current + troop.space <= capacity.max;
    const isAvailable = !isLocked && canAfford && hasFood && hasSpace;

    return (
      <button
        type="button"
        key={troop.id}
        className={`faction-troop-card ${isCore ? 'core-troop-card' : ''} ${isLocked ? 'locked' : ''} ${!isAvailable && !isLocked ? 'disabled' : ''} ${isFlagship ? 'flagship' : ''}`}
        aria-disabled={!isAvailable}
        onClick={() => { if (isAvailable) { soundSystem.play('click'); void onTrainTroop(troop.id); } }}
        onMouseEnter={(event) => !isLocked && handleMouseEnter(troop.id, event)}
        onMouseLeave={handleMouseLeave}
      >
        <TroopIcon type={troop.id} className="faction-troop-icon" />
        <span className="faction-troop-copy">
          <strong>{troop.name}</strong>
          {label && <small>{label}</small>}
        </span>
        {isLocked ? (
          <span className="faction-troop-lock">{lockText}</span>
        ) : (
          <>
            <span className="faction-troop-cost faction-troop-resource-stack">
              <span className={!canAfford ? 'short' : ''}><span className="icon gold-icon" /><span className="faction-troop-cost-value">{formatGold(troop.cost, false, false)}</span></span>
              <span className={!hasFood ? 'short' : ''}><span className="icon food-icon" /><span className="faction-troop-cost-value">{foodCost}</span></span>
              {!hasSpace && <em>NO SPACE</em>}
            </span>
            <b
              className="faction-troop-level-badge"
              title={troopLevelUpgrading ? 'Troops fight at level 1 while the lab is upgrading' : undefined}
            >
              LV {troopLevel}{troopLevelUpgrading ? ' · LAB' : ''}
            </b>
          </>
        )}
      </button>
    );
  };

  return (
    <div className={`modal-overlay ${showCloudOverlay ? 'hidden-ui' : ''}`} onClick={() => { soundSystem.play('uiClose'); onClose(); }}>
      <div className="training-modal faction-training-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Train Army</h2>
          <div className="header-actions">
            <button
              className={`header-btn practice ${capacity.current === 0 ? 'disabled' : ''}`}
              onClick={() => { soundSystem.play('confirm'); onStartPractice(); }}
              disabled={capacity.current === 0}
            >
              <div className="btn-icon icon practice-icon"></div>
              <span className="btn-label">PRACTICE</span>
            </button>
            <button
              className={`header-btn find-match ${capacity.current === 0 ? 'disabled' : ''}`}
              onClick={() => { soundSystem.play('confirm'); onFindMatch(); }}
              disabled={capacity.current === 0}
            >
              <div className="btn-icon icon findmatch-icon"></div>
              <span className="btn-label">FIND MATCH</span>
            </button>
            <button className="pxf-close" onClick={() => { soundSystem.play('uiClose'); onClose(); }} aria-label="Close"><span className="sym sym-close small" /></button>
          </div>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
            <span className="queue-label" style={{ margin: 0, color: capacity.current >= capacity.max ? 'var(--warn-red)' : '#fff' }}>
              {capacity.current}/{capacity.max}
            </span>
          </div>
          <div className="army-queue">
            {Object.entries(army).filter(([, count]) => count > 0).map(([type, count]) => (
              <div key={type} className="queue-item">
                <button className="remove-btn" onClick={() => { soundSystem.play('untrain'); void onUntrainTroop(type); }}>×</button>
                <TroopIcon type={type} />
                <div className="count">x{count}</div>
              </div>
            ))}
            {capacity.current === 0 && <div className="hint" style={{ width: '100%', opacity: 0.5 }}>Army is empty. Train some troops below!</div>}
          </div>

          <section className="core-troop-section" aria-labelledby="core-troops-heading">
            <header className="core-troop-header">
              <div>
                <span className="troop-faction-kicker">Core Troops</span>
                <strong id="core-troops-heading">Army Camp Progression</strong>
              </div>
              <span className={`core-troop-access ${armyCampLevel === 0 ? 'offline' : ''}`}>
                {armyCampUpgrading
                  ? armyCampUpgradingToLevel !== null && armyCampUpgradingToLevel > armyCampLevel
                    ? `CAMP LV ${armyCampLevel} → ${armyCampUpgradingToLevel}`
                    : armyCampLevel > 0 ? `CAMP LV ${armyCampLevel} · UPGRADING` : 'CAMP UPGRADING'
                  : armyCampLevel > 0 ? `CAMP LV ${armyCampLevel}/${CORE_TROOP_TYPES.length}` : 'NO CAMP'}
              </span>
            </header>
            <p className="core-troop-description">
              Upgrade an Army Camp to muster stronger core formations. These troops do not require either Barracks path.
            </p>
            <div className="core-troop-grid">
              {CORE_TROOP_TYPES.map(troopId => {
                const unlockLevel = getCoreTroopUnlockLevel(troopId);
                const isLocked = unlockLevel > armyCampLevel;
                const unlockingWithCurrentUpgrade = armyCampUpgradingToLevel !== null
                  && unlockLevel <= armyCampUpgradingToLevel;
                const lockText = unlockingWithCurrentUpgrade
                  ? `UPGRADING TO CAMP LV ${armyCampUpgradingToLevel}`
                  : armyCampLevel === 0
                    ? 'BUILD ARMY CAMP'
                    : `NEEDS CAMP LV ${unlockLevel}`;
                return renderTroopCard({
                  troopId,
                  label: `CAMP LV ${unlockLevel}`,
                  isLocked,
                  lockText,
                  isCore: true
                });
              })}
            </div>
          </section>

          <div className="troop-faction-grid" aria-label="Troop technology trees">
            {TROOP_FACTIONS.map(faction => {
              const meta = TROOP_FACTION_META[faction];
              const branchLevel = barracksLevels[faction];
              const branchUpgrading = barracksUpgrading[faction];
              const branchTierCount = TROOP_TECH_TREES[faction].length;
              const branchLevelLabel = branchLevel > branchTierCount
                ? `LV ${branchLevel} · MASTERY`
                : `LV ${branchLevel}/${branchTierCount}`;
              return (
                <section
                  className={`troop-faction-column faction-${faction}`}
                  key={faction}
                  style={{ '--faction-accent': meta.accent } as React.CSSProperties}
                >
                  <header className="troop-faction-header">
                    <div>
                      <strong className="troop-faction-summary">
                        {meta.name} <span>- {meta.description}</span>
                      </strong>
                    </div>
                    <span className={`troop-faction-level ${branchLevel === 0 ? 'offline' : ''}`}>
                      {branchUpgrading ? 'UPGRADING' : branchLevel > 0 ? branchLevelLabel : 'NOT BUILT'}
                    </span>
                  </header>

                  <div className="troop-tech-lane">
                    {TROOP_TECH_TREES[faction].map((troopId, tierIndex) => {
                      const unlockLevel = getTroopUnlockLevel(troopId);
                      const isLocked = unlockLevel > branchLevel;
                      const isFlagship = tierIndex === TROOP_TECH_TREES[faction].length - 1;
                      const lockText = branchUpgrading
                        ? 'BARRACKS UPGRADING'
                        : branchLevel === 0
                          ? `BUILD ${meta.shortName.toUpperCase()}`
                          : `NEEDS LV ${unlockLevel}`;

                      return renderTroopCard({
                        troopId,
                        isLocked,
                        lockText,
                        isFlagship
                      });
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>

      {tooltip && tooltipTroop && tooltipScaled && (
        <div
          ref={tooltipRef}
          className="troop-tooltip"
          style={{
            position: 'fixed',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, calc(-100% - 10px))',
            zIndex: 10000
          }}
        >
          <div className="tooltip-flavor">{tooltipFlavor}</div>
          <div className="tooltip-stats">
            {/* Lab-scaled damage is a deliberate float for the sim (14 × 1.3
                = 18.2) — the sheet shows whole numbers like health does. */}
            <span><span className="sym sym-heart small" /> {tooltipScaled.health}</span>
            <span><span className="sym sym-swords small" /> {Math.round(tooltipScaled.damage)}</span>
            <span><span className="sym sym-slot small" /> {tooltipTroop.space}</span>
          </div>
        </div>
      )}
    </div>
  );
}
