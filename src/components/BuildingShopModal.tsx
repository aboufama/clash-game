import { type BuildingDef, type BuildingType } from '../game/config/GameDefinitions';
import { placementCharge } from '../game/config/Economy';
import { formatGold } from '../game/economy/Currency';
import { soundSystem } from '../game/systems/SoundSystem';

interface BuildingShopModalProps {
  isOpen: boolean;
  showCloudOverlay: boolean;
  buildingList: BuildingDef[];
  buildingCounts: Record<string, number>;
  resources: { gold: number; ore: number };
  shopWallLevel: number;
  onClose: () => void;
  onSelect: (id: string) => void;
}

/** Shop sections in display order, keyed by definition category. */
const SHOP_SECTIONS: Array<{ label: string; categories: string[] }> = [
  { label: 'Defenses', categories: ['defense'] },
  { label: 'Military', categories: ['military', 'army'] },
  { label: 'Economy', categories: ['resource'] },
  { label: 'Village', categories: ['other'] }
];

export function BuildingShopModal({
  isOpen,
  showCloudOverlay,
  buildingList,
  buildingCounts,
  resources,
  shopWallLevel,
  onClose,
  onSelect
}: BuildingShopModalProps) {
  if (!isOpen) return null;

  const renderCard = (b: BuildingDef) => {
    const placementLevel = b.id === 'wall' ? Math.max(1, shopWallLevel) : 1;
    const charge = placementCharge(b.id as BuildingType, placementLevel);
    const cost = charge.gold;
    let name = b.name;

    // Dynamic Wall Cost/Level in Shop
    if (b.id === 'wall' && shopWallLevel > 1) {
      name = `${b.name} (Lvl ${shopWallLevel})`;
    }

    const owned = buildingCounts[b.id] || 0;
    const maxed = owned >= b.maxCount;
    const oreCost = charge.ore;
    const affordable = resources.gold >= cost;
    const oreAffordable = resources.ore >= oreCost;
    const isDisabled = !affordable || !oreAffordable || maxed;

    return (
      <div
        key={b.id}
        className={`bshop-card ${isDisabled ? 'disabled' : ''} ${maxed ? 'maxed' : ''}`}
        onClick={() => {
          if (!isDisabled) {
            soundSystem.play('click');
            onSelect(b.id);
          }
        }}
      >
        <div className="bshop-thumb">
          <div className={`icon ${b.id}-icon large`}></div>
          <div className={`bshop-count ${maxed ? 'full' : ''}`}>{owned}/{b.maxCount}</div>
          {maxed && <div className="bshop-maxed-ribbon">MAX</div>}
        </div>
        <div className="bshop-info">
          <span className="bshop-name">{name}</span>
          <span className="bshop-desc">{b.desc}</span>
        </div>
        <div className="bshop-cost-row">
          <div className={`bshop-cost ${affordable ? '' : 'short'}`}>
            <span className="icon gold-icon"></span>
            <span>{formatGold(cost, false, false)}</span>
          </div>
          {oreCost > 0 && (
            <div className={`bshop-cost ore ${oreAffordable ? '' : 'short'}`}>
              <span className="icon ore-icon"></span>
              <span>{formatGold(oreCost, false, false)}</span>
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`modal-overlay ${showCloudOverlay ? 'hidden-ui' : ''}`} onClick={onClose}>
      <div className="training-modal bshop-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Building Shop</h2>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body bshop-body">
          {SHOP_SECTIONS.map(section => {
            const items = buildingList.filter(b => section.categories.includes(b.category || 'other'));
            if (items.length === 0) return null;
            return (
              <div className="bshop-section" key={section.label}>
                <div className="bshop-section-title">
                  <span className="bshop-section-rule" />
                  {section.label}
                  <span className="bshop-section-rule" />
                </div>
                <div className="bshop-grid">
                  {items.map(renderCard)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
