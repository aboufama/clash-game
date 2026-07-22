import { useEffect, useRef } from 'react';
import { soundSystem } from '../game/systems/SoundSystem';

interface IntroBattleScrollProps {
  onEnterBattle: () => void;
}

/** The first thing a newly created chief sees: a modal summons rendered as a
 * parchment scroll above the still-closed cloud barrier. */
export function IntroBattleScroll({ onEnterBattle }: IntroBattleScrollProps) {
  const enterButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const keepFocusOnSummons = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      enterButtonRef.current?.focus();
    };
    document.addEventListener('keydown', keepFocusOnSummons, true);
    enterButtonRef.current?.focus();
    return () => document.removeEventListener('keydown', keepFocusOnSummons, true);
  }, []);

  return (
    <div className="intro-battle-overlay" role="presentation">
      <section
        className="intro-battle-scroll"
        role="dialog"
        aria-modal="true"
        aria-labelledby="intro-battle-title"
        aria-describedby="intro-battle-copy"
      >
        <span className="intro-scroll-roll intro-scroll-roll-top" aria-hidden="true" />
        <span className="intro-scroll-roll intro-scroll-roll-bottom" aria-hidden="true" />
        <div className="intro-scroll-seal" aria-hidden="true"><span className="sym sym-swords" /></div>
        <p className="intro-scroll-kicker">A Royal Summons</p>
        <h2 id="intro-battle-title">SIR ANDRE NEEDS YOU</h2>
        <p id="intro-battle-copy" className="intro-scroll-copy">
          The Iron Crown has sealed itself behind a max-level fortress. Sir Andre&apos;s
          vanguard is waiting at the border. Take command and break the citadel.
        </p>
        <div className="intro-scroll-army" aria-label="Army supplied by Sir Andre">
          <span>STONE GOLEMS</span>
          <i aria-hidden="true">◆</i>
          <span>DA VINCI TANKS</span>
          <i aria-hidden="true">◆</i>
          <span>TREBUCHETS</span>
          <i aria-hidden="true">◆</i>
          <span>SIEGE TOWERS</span>
        </div>
        <p className="intro-scroll-order">Select a unit, then deploy it along the glowing village border.</p>
        <button
          ref={enterButtonRef}
          type="button"
          className="intro-scroll-enter"
          autoFocus
          onClick={() => {
            soundSystem.play('confirm');
            onEnterBattle();
          }}
        >
          ENTER BATTLE
        </button>
        <small>— By order of Sir Andre —</small>
      </section>
    </div>
  );
}
