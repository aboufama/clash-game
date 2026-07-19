import { useState } from 'react';
import { soundSystem } from '../game/systems/SoundSystem';
import type { MerchantOffer } from '../game/systems/VillageLifeSystem';

interface MerchantModalProps {
  offers: MerchantOffer[] | null;
  resources: { gold: number; ore: number; food: number };
  onTrade: (offer: MerchantOffer) => void;
  onClose: () => void;
}

const KIND_ICON: Record<'gold' | 'ore' | 'food', string> = {
  gold: 'gold-icon',
  ore: 'ore-icon',
  food: 'food-icon'
};

const KIND_NAME: Record<'gold' | 'ore' | 'food', string> = {
  gold: 'gold',
  ore: 'ore',
  food: 'food'
};

/**
 * The traveling merchant's trade sheet: three take-it-or-leave-it deals per
 * visit. Each row spends the left side and pays out the right; a bargain row
 * is the lucky find worth grabbing before he packs up.
 */
export function MerchantModal({ offers, resources, onTrade, onClose }: MerchantModalProps) {
  const [, setTick] = useState(0);
  if (!offers) return null;

  const canAfford = (offer: MerchantOffer) =>
    resources[offer.give.kind] >= offer.give.amount;

  const trade = (offer: MerchantOffer) => {
    if (offer.done || !canAfford(offer)) return;
    onTrade(offer);
    setTick(t => t + 1); // reflect the done state immediately
  };

  return (
    <div className="modal-overlay" onClick={() => { soundSystem.play('uiClose'); onClose(); }}>
      <div className="training-modal merchant-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Traveling Merchant</h2>
          <span className="merchant-sub">Here till sundown</span>
          <button className="pxf-close" onClick={() => { soundSystem.play('uiClose'); onClose(); }} aria-label="Close"><span className="sym sym-close small" /></button>
        </div>
        <div className="modal-body merchant-body">
          {offers.map(offer => {
            const affordable = canAfford(offer);
            return (
              <div
                key={offer.id}
                className={`merchant-offer ${offer.bargain ? 'bargain' : ''} ${offer.done ? 'done' : ''}`}
              >
                {offer.bargain && !offer.done && <span className="merchant-bargain-tag">BARGAIN</span>}
                <div className="merchant-sides">
                  <span className="merchant-side give">
                    <span className={`icon ${KIND_ICON[offer.give.kind]}`} />
                    {offer.give.amount} {KIND_NAME[offer.give.kind]}
                  </span>
                  <span className="merchant-arrow"><span className="sym sym-arrow small" /></span>
                  <span className="merchant-side get">
                    <span className={`icon ${KIND_ICON[offer.get.kind]}`} />
                    {offer.get.amount} {KIND_NAME[offer.get.kind]}
                  </span>
                </div>
                <button
                  className={`merchant-trade-btn ${offer.done ? 'done' : affordable ? '' : 'disabled'}`}
                  disabled={offer.done || !affordable}
                  onClick={() => trade(offer)}
                >
                  {offer.done ? 'SOLD' : affordable ? 'TRADE' : `NEED ${KIND_NAME[offer.give.kind].toUpperCase()}`}
                </button>
              </div>
            );
          })}
          <div className="merchant-footnote">One of each deal per visit. He moves on before nightfall.</div>
        </div>
      </div>
    </div>
  );
}
