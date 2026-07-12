import { useState } from 'react';
import { soundSystem } from '../game/systems/SoundSystem';

interface JukeboxModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The jukebox songbook: pick any unlocked track to pin it, or Auto to let the
 * day/night cycle choose. Rare tracks show as ??? until they're found.
 */
export function JukeboxModal({ isOpen, onClose }: JukeboxModalProps) {
  const [, setTick] = useState(0);
  if (!isOpen) return null;

  const tracks = soundSystem.getTracks();
  const current = soundSystem.overrideActive ? soundSystem.currentTrackId() : null;
  const unlockedCount = tracks.filter(t => t.unlocked).length;

  const pick = (id: string | null) => {
    soundSystem.setTrack(id);
    soundSystem.play('click');
    setTick(t => t + 1); // re-render the PLAYING badge
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="training-modal jukebox-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Jukebox</h2>
          <span className="jukebox-count">{unlockedCount}/{tracks.length} tracks</span>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="modal-body jukebox-body">
          <div
            className={`jukebox-track auto ${current === null ? 'playing' : ''}`}
            onClick={() => pick(null)}
          >
            <span className="jukebox-note">~</span>
            <div className="jukebox-info">
              <span className="jukebox-name">Auto</span>
              <span className="jukebox-hint">Follows the day and the night.</span>
            </div>
            {current === null && <span className="jukebox-playing">PLAYING</span>}
          </div>
          {tracks.map(t => (
            <div
              key={t.id}
              className={`jukebox-track ${t.unlocked ? '' : 'locked'} ${t.rare ? 'rare' : ''} ${current === t.id ? 'playing' : ''}`}
              onClick={() => t.unlocked && pick(t.id)}
            >
              <span className="jukebox-note">♪</span>
              <div className="jukebox-info">
                <span className="jukebox-name">
                  {t.unlocked ? t.name : (t.rare ? '??????' : t.name)}
                  {t.rare && <span className="jukebox-rare-tag">RARE</span>}
                </span>
                <span className="jukebox-hint">{t.unlocked ? '' : t.hint}</span>
              </div>
              {current === t.id && <span className="jukebox-playing">PLAYING</span>}
              {!t.unlocked && <span className="sym sym-lock small jukebox-locked" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
