export type WatchtowerTutorialStage = 'build' | 'shop' | 'place' | 'saving' | 'complete';

const COPY: Record<WatchtowerTutorialStage, { kicker: string; title: string; body: string }> = {
  build: {
    kicker: 'Sir Andre’s First Order',
    title: 'Raise the Watch',
    body: 'Every village needs eyes beyond its walls. Open BUILD to begin.'
  },
  shop: {
    kicker: 'Village Defenses',
    title: 'Choose the Watchtower',
    body: 'Select the highlighted Watchtower in the Village section.'
  },
  place: {
    kicker: 'Choose Clear Ground',
    title: 'Place the Watchtower',
    body: 'Move the tower over your village, then tap a clear patch to set it down.'
  },
  saving: {
    kicker: 'The Royal Scribe',
    title: 'Securing the Foundation',
    body: 'Hold a moment while your Watchtower is recorded in the realm.'
  },
  complete: {
    kicker: 'The Watch Is Raised',
    title: 'The Horizon Is Yours',
    body: 'Your guards can now see the villages and wilderness around you.'
  }
};

export function WatchtowerPlacementGuide({ stage }: { stage: WatchtowerTutorialStage }) {
  const copy = COPY[stage];
  return (
    <aside
      className={`watchtower-placement-guide stage-${stage}`}
      role="status"
      aria-live="polite"
      aria-labelledby="watchtower-guide-title"
      aria-describedby="watchtower-guide-copy"
    >
      <div className="watchtower-guide-seal" aria-hidden="true">
        <span className="sym sym-watch" />
      </div>
      <div className="watchtower-guide-words">
        <p>{copy.kicker}</p>
        <h2 id="watchtower-guide-title">{copy.title}</h2>
        <span id="watchtower-guide-copy">{copy.body}</span>
      </div>
      {(stage === 'build' || stage === 'place') && (
        <span className="watchtower-guide-arrow" aria-hidden="true">➤</span>
      )}
      {stage === 'saving' && <span className="watchtower-guide-spinner" aria-hidden="true" />}
      {stage === 'complete' && <span className="watchtower-guide-check" aria-hidden="true">✓</span>}
    </aside>
  );
}
