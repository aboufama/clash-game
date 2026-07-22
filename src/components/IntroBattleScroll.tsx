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
        <p className="intro-scroll-kicker">A Royal Summons</p>
        <h2 id="intro-battle-title" className="display-title">Sir Andre Needs Your Help</h2>
        <div id="intro-battle-copy" className="intro-scroll-copy">
          <p>Chief,</p>
          <p>
            The Iron Crown has sealed itself behind a mighty fortress. My vanguard
            waits at the border, but without a commander the citadel will not fall.
          </p>
          <p>Will you come to our aid and lead the attack?</p>
          <p className="intro-scroll-closing">— Sir Andre</p>
        </div>
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
          <span>Sign here to answer the call</span>
          <strong>ATTACK</strong>
        </button>
      </section>
    </div>
  );
}
