import { useEffect, useState } from 'react';
import { soundSystem } from '../game/systems/SoundSystem';
import { musicSystem, type MusicTrack } from '../game/systems/MusicSystem';

interface JukeboxModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/** Manifest contexts grouped into readable player sections, in play order. */
const SECTIONS: Array<{ title: string; contexts: string[] }> = [
  { title: 'Village', contexts: ['home'] },
  { title: 'Nightfall', contexts: ['night'] },
  { title: 'The Wilds', contexts: ['world'] },
  { title: 'Battle', contexts: ['battle'] },
  { title: 'Classics', contexts: ['title'] },
  {
    title: 'Fanfares & Jingles',
    contexts: [
      'victory', 'defeat',
      'jingle_victory', 'jingle_defeat', 'jingle_reveal', 'jingle_build', 'jingle_loot'
    ]
  }
];

function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '–:––';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The RuneScape music player: the full streamed soundtrack grouped by mood.
 * Click a track to pin it (it loops until "Resume auto"); the rotation
 * otherwise follows home / night / world overview / battle automatically.
 * Falls back to the legacy procedural songbook when the streamed soundtrack
 * is disabled via the kill switch (localStorage['clash.music.off']).
 */
export function JukeboxModal({ isOpen, onClose }: JukeboxModalProps) {
  const [, setTick] = useState(0);
  const [nowPlaying, setNowPlaying] = useState<MusicTrack | null>(null);
  const [volume, setVolume] = useState(() => musicSystem.getVolume());
  const [sfxVolume, setSfxVolume] = useState(() => soundSystem.getSfxVolume());

  // Now-playing indicator: poll ~1 s while the modal is open. The same poll
  // samples `active` (enabled AND manifest loaded) into state — the manifest
  // can finish loading (or fail) while the modal is open, and the view must
  // flip live from the fallback songbook to the streamed player.
  const [streamActive, setStreamActive] = useState(() => musicSystem.active);
  useEffect(() => {
    if (!isOpen) return;
    const poll = () => {
      setStreamActive(musicSystem.active);
      setNowPlaying(musicSystem.active ? musicSystem.getNowPlaying() : null);
    };
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => window.clearInterval(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  const closeWithSound = () => {
    soundSystem.play('uiClose');
    onClose();
  };
  const onSfxVolume = (v: number) => {
    // Deliberately silent while dragging; SoundSystem persists the value.
    soundSystem.setSfxVolume(v);
    setSfxVolume(v);
  };
  const sfxVolumeRow = (
    <div className="jukebox-track auto" style={{ cursor: 'default' }}>
      <span className="jukebox-note">%</span>
      <div className="jukebox-info" style={{ flex: 1 }}>
        <span className="jukebox-name">Effects volume — {Math.round(sfxVolume * 100)}%</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(sfxVolume * 100)}
          onChange={e => onSfxVolume(Number(e.target.value) / 100)}
          style={{ width: '100%' }}
          aria-label="Sound effects volume"
        />
      </div>
    </div>
  );

  // ----- fallback branch: the streamed soundtrack is unavailable (kill
  // switch on, or its manifest never loaded) — the procedural songbook
  // plays, so that is the list the player should see.
  if (!streamActive) {
    const tracks = soundSystem.getTracks();
    const current = soundSystem.overrideActive ? soundSystem.currentTrackId() : null;
    const unlockedCount = tracks.filter(t => t.unlocked).length;
    const playingLabel = soundSystem.muted ? 'MUTED' : 'PLAYING';
    const playingClass = `jukebox-playing ${soundSystem.muted ? 'muted' : ''}`;
    const pick = (id: string | null) => {
      soundSystem.setTrack(id);
      soundSystem.play('click');
      setTick(t => t + 1);
    };
    return (
      <div className="modal-overlay" onClick={closeWithSound}>
        <div className="training-modal jukebox-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Jukebox</h2>
            <span className="jukebox-count">{unlockedCount}/{tracks.length} tracks</span>
            <button className="pxf-close" onClick={closeWithSound} aria-label="Close"><span className="sym sym-close small" /></button>
          </div>
          <div className="modal-body jukebox-body">
            {musicSystem.enabled && (
              <div className="jukebox-hint" style={{ opacity: 0.7, margin: '2px 2px 8px' }} role="status">
                Soundtrack unavailable — procedural music playing.
              </div>
            )}
            {sfxVolumeRow}
            <div className={`jukebox-track auto ${current === null ? 'playing' : ''}`} onClick={() => pick(null)}>
              <span className="jukebox-note">~</span>
              <div className="jukebox-info">
                <span className="jukebox-name">Auto</span>
                <span className="jukebox-hint">Follows the day and the night.</span>
              </div>
              {current === null && <span className={playingClass}>{playingLabel}</span>}
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
                {current === t.id && <span className={playingClass}>{playingLabel}</span>}
                {!t.unlocked && <span className="sym sym-lock small jukebox-locked" />}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // -------------------- streamed RuneScape soundtrack player --------------
  const tracks = musicSystem.getTracks();
  const byContext = new Map<string, MusicTrack[]>();
  for (const t of tracks) {
    const list = byContext.get(t.context);
    if (list) list.push(t);
    else byContext.set(t.context, [t]);
  }
  const pinned = musicSystem.getOverride();
  const autoActive = pinned === null;
  const playingLabel = soundSystem.muted ? 'MUTED' : 'PLAYING';
  const playingClass = `jukebox-playing ${soundSystem.muted ? 'muted' : ''}`;

  const pick = (slug: string) => {
    musicSystem.playTrack(slug);
    soundSystem.play('click');
    setNowPlaying(musicSystem.getNowPlaying());
    setTick(t => t + 1);
  };
  const resumeAuto = () => {
    musicSystem.resumeAuto();
    soundSystem.play('click');
    setNowPlaying(musicSystem.getNowPlaying());
    setTick(t => t + 1);
  };
  const onVolume = (v: number) => {
    musicSystem.setVolume(v);
    setVolume(v);
  };

  return (
    <div className="modal-overlay" onClick={closeWithSound}>
      <div className="training-modal jukebox-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Music Player</h2>
          <span className="jukebox-count">{tracks.length} tracks</span>
          <button className="pxf-close" onClick={closeWithSound} aria-label="Close"><span className="sym sym-close small" /></button>
        </div>
        <div className="modal-body jukebox-body">
          <div
            className={`jukebox-track auto ${autoActive ? 'playing' : ''}`}
            onClick={resumeAuto}
          >
            <span className="jukebox-note">~</span>
            <div className="jukebox-info">
              <span className="jukebox-name">Resume auto</span>
              <span className="jukebox-hint">
                {autoActive
                  ? (nowPlaying ? `Now playing: ${nowPlaying.name}` : 'Follows the village, the night, the wilds and the war.')
                  : 'Return to the automatic rotation.'}
              </span>
            </div>
            {autoActive && <span className={playingClass}>{playingLabel}</span>}
          </div>

          <div className="jukebox-track auto" style={{ cursor: 'default' }}>
            <span className="jukebox-note">))</span>
            <div className="jukebox-info" style={{ flex: 1 }}>
              <span className="jukebox-name">Music volume — {Math.round(volume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(volume * 100)}
                onChange={e => onVolume(Number(e.target.value) / 100)}
                style={{ width: '100%' }}
                aria-label="Music volume"
              />
            </div>
          </div>

          {sfxVolumeRow}

          {SECTIONS.map(section => {
            const sectionTracks = section.contexts.flatMap(ctx => byContext.get(ctx) ?? []);
            if (sectionTracks.length === 0) return null;
            return (
              <div key={section.title}>
                <div
                  className="jukebox-section"
                  style={{
                    opacity: 0.75, fontSize: '0.78em', letterSpacing: '0.08em',
                    textTransform: 'uppercase', margin: '10px 2px 4px'
                  }}
                >
                  {section.title}
                </div>
                {sectionTracks.map(t => {
                  const isNow = nowPlaying?.slug === t.slug;
                  const isPinned = pinned === t.slug;
                  return (
                    <div
                      key={t.slug}
                      className={`jukebox-track ${isNow || isPinned ? 'playing' : ''}`}
                      onClick={() => pick(t.slug)}
                    >
                      <span className="jukebox-note">{isNow ? '♫' : '♪'}</span>
                      <div className="jukebox-info">
                        <span className="jukebox-name">{t.name}</span>
                        <span className="jukebox-hint">{formatDuration(t.duration)}{isPinned ? ' · looping' : ''}</span>
                      </div>
                      {isNow && <span className={playingClass}>{playingLabel}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {musicSystem.getAttribution() && (
            <div style={{ opacity: 0.55, fontSize: '0.72em', margin: '12px 2px 2px', lineHeight: 1.4 }}>
              {musicSystem.getAttribution()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
