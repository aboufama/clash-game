interface IntroBattleGuideProps {
  deployed: number;
}

/** Compact battlefield coaching; the first deployment teaches the basic
 * gesture and the next few encourage a useful spread instead of one clump. */
export function IntroBattleGuide({ deployed }: IntroBattleGuideProps) {
  const title = deployed === 0
    ? 'CHOOSE A UNIT BELOW'
    : deployed < 3
      ? 'SPREAD OUT THE VANGUARD'
      : 'BREAK THE IRON CROWN';
  const copy = deployed === 0
    ? 'Then tap the glowing grass along the fortress border to deploy.'
    : deployed < 3
      ? 'Deploy the next group from another side of the village.'
      : 'The army knows its targets now. Keep sending in Sir Andre’s heavy troops.';

  return (
    <aside className="intro-battle-guide" role="status" aria-live="polite">
      <span className="intro-guide-sigil" aria-hidden="true"><span className="sym sym-swords small" /></span>
      <span className="intro-guide-copy">
        <small>Sir Andre&apos;s command</small>
        <strong>{title}</strong>
        <em>{copy}</em>
      </span>
      <span className="intro-guide-steps" aria-hidden="true">
        {[0, 1, 2].map(step => <i key={step} className={deployed > step ? 'done' : ''} />)}
      </span>
    </aside>
  );
}
