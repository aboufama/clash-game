import { formatGold } from '../game/economy/Currency';

interface BattleStats {
  destruction: number;
  goldLooted: number;
  oreLooted?: number;
  foodLooted?: number;
}

interface BattleResultsModalProps {
  isOpen: boolean;
  stats: BattleStats;
  onGoHome: () => void;
}

export function BattleResultsModal({ isOpen, stats, onGoHome }: BattleResultsModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="battle-results">
        <h1 className="battle-results-title">VICTORY!</h1>
        <div className="battle-results-stats">
          <div className="battle-stat">
            <span className="battle-stat-label">DESTRUCTION:</span>
            <span className="battle-stat-value destruction">{stats.destruction}%</span>
          </div>
          <div className="battle-stat">
            <span className="battle-stat-label">LOOT GAINED:</span>
            <span className="battle-stat-value battle-resource-value">
              <span className="icon gold-icon"></span>
              {formatGold(stats.goldLooted, false, false)}
            </span>
          </div>
          {((stats.oreLooted ?? 0) > 0 || (stats.foodLooted ?? 0) > 0) && (
            <div className="battle-stat">
              <span className="battle-stat-label">STOCKS CARRIED:</span>
              <span className="battle-stat-value battle-resource-value">
                {(stats.oreLooted ?? 0) > 0 && <><span className="icon ore-icon"></span>{stats.oreLooted} </>}
                {(stats.foodLooted ?? 0) > 0 && <><span className="icon food-icon"></span>{stats.foodLooted}</>}
              </span>
            </div>
          )}
        </div>
        <button className="battle-home-btn" onClick={onGoHome}>
          <span className="btn-icon sym sym-home" />
          <span className="btn-label">GO HOME</span>
        </button>
      </div>
    </div>
  );
}
