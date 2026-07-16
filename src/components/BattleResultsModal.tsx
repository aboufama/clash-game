import { formatGold } from '../game/economy/Currency';

export interface RaidReportStats {
  destruction: number;
  goldLooted: number;
  oreLooted?: number;
  foodLooted?: number;
  /** The player pulled out mid-raid — the banked partial result. */
  retreated?: boolean;
  /** Settlement transport failed: the payout is pending, NOT zero. */
  settlementDelayed?: boolean;
  /** Server-applied trophy change (retreat reports carry it when known). */
  trophyDelta?: number;
}

interface BattleResultsModalProps {
  isOpen: boolean;
  stats: RaidReportStats;
  /** Dismiss the report (shown after the clouds open on the home village). */
  onClose: () => void;
}

export function BattleResultsModal({ isOpen, stats, onClose }: BattleResultsModalProps) {
  if (!isOpen) return null;

  const title = stats.retreated
    ? 'RETREATED'
    : stats.destruction >= 50 ? 'VICTORY!' : 'RAID ENDED';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="battle-results" onClick={e => e.stopPropagation()}>
        <h1 className="battle-results-title">{title}</h1>
        <div className="battle-results-stats">
          <div className="battle-stat">
            <span className="battle-stat-label">DESTRUCTION:</span>
            <span className="battle-stat-value destruction">{stats.destruction}%</span>
          </div>
          <div className="battle-stat">
            <span className="battle-stat-label">LOOT GAINED:</span>
            <span className="battle-stat-value battle-resource-value">
              {stats.settlementDelayed ? (
                'SETTLING…'
              ) : (
                <>
                  <span className="icon gold-icon"></span>
                  {formatGold(stats.goldLooted, false, false)}
                </>
              )}
            </span>
          </div>
          {!stats.settlementDelayed && ((stats.oreLooted ?? 0) > 0 || (stats.foodLooted ?? 0) > 0) && (
            <div className="battle-stat">
              <span className="battle-stat-label">STOCKS CARRIED:</span>
              <span className="battle-stat-value battle-resource-value">
                {(stats.oreLooted ?? 0) > 0 && <><span className="icon ore-icon"></span>{stats.oreLooted} </>}
                {(stats.foodLooted ?? 0) > 0 && <><span className="icon food-icon"></span>{stats.foodLooted}</>}
              </span>
            </div>
          )}
          {typeof stats.trophyDelta === 'number' && stats.trophyDelta !== 0 && (
            <div className="battle-stat">
              <span className="battle-stat-label">TROPHIES:</span>
              <span className="battle-stat-value">
                {stats.trophyDelta > 0 ? `+${stats.trophyDelta}` : `${stats.trophyDelta}`}
              </span>
            </div>
          )}
          {stats.settlementDelayed && (
            <div className="battle-stat">
              <span className="battle-stat-label" style={{ opacity: 0.8 }}>
                The caravan is delayed — your spoils will be banked shortly.
              </span>
            </div>
          )}
        </div>
        <button className="battle-home-btn" onClick={onClose}>
          <span className="btn-icon sym sym-home" />
          <span className="btn-label">CONTINUE</span>
        </button>
      </div>
    </div>
  );
}
