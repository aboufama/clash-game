import { type BuildingDef, type BuildingType } from '../game/config/GameDefinitions';
import { placementCharge } from '../game/config/Economy';
import { formatGold } from '../game/economy/Currency';
import { soundSystem } from '../game/systems/SoundSystem';
import { BuildingIcon } from './BuildingIcon';

interface BuildingShopModalProps {
  isOpen: boolean;
  showCloudOverlay: boolean;
  buildingList: BuildingDef[];
  buildingCounts: Record<string, number>;
  resources: { gold: number; ore: number };
  shopWallLevel: number;
  onClose: () => void;
  onSelect: (id: string) => void;
  /** Locks the shop to one authored onboarding choice. */
  tutorialRequiredType?: BuildingType | null;
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
  onSelect,
  tutorialRequiredType = null
}: BuildingShopModalProps) {
  if (!isOpen) return null;
  const visibleBuildingList = tutorialRequiredType
    ? buildingList.filter(building => building.id === tutorialRequiredType)
    : buildingList;

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
    const tutorialTarget = tutorialRequiredType === b.id;
    const isDisabled = !affordable || !oreAffordable || maxed
      || (tutorialRequiredType !== null && !tutorialTarget);

    return (
      <div
        key={b.id}
        className={`bshop-card ${isDisabled ? 'disabled' : ''} ${maxed ? 'maxed' : ''} ${tutorialTarget ? 'watchtower-tutorial-target' : ''}`}
        aria-disabled={isDisabled}
        onClick={() => {
          if (!isDisabled) {
            soundSystem.play('click');
            onSelect(b.id);
          }
        }}
      >
        <div className="bshop-thumb">
          <BuildingIcon type={b.id} className="bshop-building-icon" />
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
    <div className={`modal-overlay ${showCloudOverlay ? 'hidden-ui' : ''}`} onClick={() => {
      if (tutorialRequiredType) return;
      soundSystem.play('uiClose');
      onClose();
    }}>
      <div className="training-modal bshop-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tutorialRequiredType ? 'Choose Your Watchtower' : 'Building Shop'}</h2>
          {!tutorialRequiredType && (
            <button className="pxf-close" onClick={() => { soundSystem.play('uiClose'); onClose(); }} aria-label="Close"><span className="sym sym-close small" /></button>
          )}
        </div>
        <div className="modal-body bshop-body">
          {SHOP_SECTIONS.map(section => {
            const items = visibleBuildingList.filter(b => section.categories.includes(b.category || 'other'));
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
