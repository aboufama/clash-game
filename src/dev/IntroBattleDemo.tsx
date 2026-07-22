import { useState } from 'react';
import '@fontsource/jacquard-24/latin.css';
import '../App.css';
import { IntroBattleScroll } from '../components/IntroBattleScroll';

export function IntroBattleDemo() {
  const [signed, setSigned] = useState(false);

  return (
    <main className="intro-battle-demo">
      {signed ? (
        <section className="intro-battle-demo-result" aria-live="polite">
          <h1 className="display-title">Summons Signed</h1>
          <p>The live game starts Sir Andre&apos;s attack at this point.</p>
          <button type="button" onClick={() => setSigned(false)}>SHOW THE SCROLL AGAIN</button>
          <a href="/game">OPEN THE GAME</a>
        </section>
      ) : (
        <IntroBattleScroll onEnterBattle={() => setSigned(true)} />
      )}
    </main>
  );
}
