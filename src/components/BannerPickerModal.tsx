import { useEffect, useMemo, useRef, useState } from 'react';
import {
    VILLAGE_BANNER_EMBLEMS,
    VILLAGE_BANNER_PALETTES,
    VILLAGE_BANNER_PATTERNS,
    villageBannersEqual,
    type VillageBanner
} from '../game/data/Models';
import {
    bannerAxesOf,
    bannerDesignFor,
    drawBannerPreview,
    villageFlagFor
} from '../game/renderers/VillageFlagRenderer';
import { Backend } from '../game/backend/GameBackend';
import { soundSystem } from '../game/systems/SoundSystem';

interface BannerPickerModalProps {
    isOpen: boolean;
    userId: string;
    onClose: () => void;
}

const EMBLEM_NAMES = ['TOWER', 'BLADE', 'OAK', 'STAR', 'MOON', 'HAMMER'];
const PATTERN_NAMES = ['SOLID', 'FESS', 'PALE', 'BEND', 'CHEVRON'];

/** One banner rendered by the REAL flag renderer onto a DOM canvas. */
function BannerSwatch({ userId, banner, width, height, scale }: {
    userId: string;
    banner: VillageBanner;
    width: number;
    height: number;
    scale: number;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        if (canvasRef.current) {
            drawBannerPreview(canvasRef.current, bannerDesignFor(userId, banner), { scale });
        }
    }, [userId, banner.palette, banner.emblem, banner.pattern, scale]);
    return <canvas ref={canvasRef} width={width} height={height} className="banner-swatch-canvas" />;
}

/**
 * The banner picker: choose the heraldry your village flies at the town
 * hall, carries to war and shows on every neighbour's world map. Every
 * swatch and the preview are painted by the SAME renderer the world uses,
 * so what you pick is exactly what flies.
 */
export function BannerPickerModal({ isOpen, userId, onClose }: BannerPickerModalProps) {
    // The explicit persisted choice (null = identity default) and the
    // identity-default axes it falls back to.
    const savedBanner = useMemo<VillageBanner | null>(
        () => (isOpen ? Backend.getCachedWorld(userId)?.banner ?? null : null),
        [isOpen, userId]
    );
    const defaultAxes = useMemo(() => bannerAxesOf(villageFlagFor(userId)), [userId]);
    const [choice, setChoice] = useState<VillageBanner>(savedBanner ?? defaultAxes);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (isOpen) {
            setChoice(savedBanner ?? defaultAxes);
            setError(null);
        }
    }, [isOpen, savedBanner, defaultAxes]);

    if (!isOpen) return null;

    const dirty = !villageBannersEqual(choice, savedBanner ?? defaultAxes);

    const pick = (next: Partial<VillageBanner>) => {
        soundSystem.play('click');
        setChoice(prev => ({ ...prev, ...next }));
    };

    const save = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        // The default axes chosen verbatim persist as an EXPLICIT banner —
        // renames/identity churn can never silently restyle the flag.
        try {
            await Backend.setVillageBanner(userId, choice);
            soundSystem.play('confirm');
            onClose();
        } catch {
            setError('The banner could not be raised — try again.');
        } finally {
            setBusy(false);
        }
    };

    const reset = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await Backend.setVillageBanner(userId, null);
            setChoice(defaultAxes);
            soundSystem.play('confirm');
            onClose();
        } catch {
            setError('The banner could not be reset — try again.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={busy ? undefined : () => { soundSystem.play('uiClose'); onClose(); }}>
            <div className="training-modal banner-modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                    <h2>Village Banner</h2>
                    <button className="pxf-close" onClick={() => { soundSystem.play('uiClose'); onClose(); }} disabled={busy} aria-label="Close"><span className="sym sym-close small" /></button>
                </div>
                <div className="modal-body banner-body">
                    <div className="banner-preview-row">
                        <BannerSwatch userId={userId} banner={choice} width={192} height={132} scale={3} />
                        <div className="banner-preview-note">
                            Flown at your town hall, carried to war and planted at the enemy gate.
                        </div>
                    </div>

                    <div className="banner-section-label">FIELD</div>
                    <div className="banner-grid">
                        {Array.from({ length: VILLAGE_BANNER_PALETTES }, (_, palette) => (
                            <button
                                key={palette}
                                className={`banner-cell ${choice.palette === palette ? 'selected' : ''}`}
                                onClick={() => pick({ palette })}
                                disabled={busy}
                            >
                                <BannerSwatch userId={userId} banner={{ ...choice, palette }} width={64} height={48} scale={1.6} />
                            </button>
                        ))}
                    </div>

                    <div className="banner-section-label">EMBLEM</div>
                    <div className="banner-grid">
                        {Array.from({ length: VILLAGE_BANNER_EMBLEMS }, (_, emblem) => (
                            <button
                                key={emblem}
                                className={`banner-cell ${choice.emblem === emblem ? 'selected' : ''}`}
                                onClick={() => pick({ emblem })}
                                disabled={busy}
                            >
                                <BannerSwatch userId={userId} banner={{ ...choice, emblem }} width={64} height={48} scale={1.6} />
                                <span className="banner-cell-name">{EMBLEM_NAMES[emblem]}</span>
                            </button>
                        ))}
                    </div>

                    <div className="banner-section-label">PATTERN</div>
                    <div className="banner-grid">
                        {Array.from({ length: VILLAGE_BANNER_PATTERNS }, (_, pattern) => (
                            <button
                                key={pattern}
                                className={`banner-cell ${(choice.pattern ?? defaultAxes.pattern) === pattern ? 'selected' : ''}`}
                                onClick={() => pick({ pattern })}
                                disabled={busy}
                            >
                                <BannerSwatch userId={userId} banner={{ ...choice, pattern }} width={64} height={48} scale={1.6} />
                                <span className="banner-cell-name">{PATTERN_NAMES[pattern]}</span>
                            </button>
                        ))}
                    </div>

                    {error && <div className="banner-error">{error}</div>}

                    <div className="banner-actions">
                        <button className="banner-save-btn" onClick={save} disabled={busy || !dirty}>
                            {busy ? 'RAISING…' : 'RAISE BANNER'}
                        </button>
                        <button className="banner-reset-btn" onClick={reset} disabled={busy || !savedBanner}>
                            VILLAGE CREST
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
