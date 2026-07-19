import { useEffect, useMemo, useRef, useState } from 'react';
import {
    VILLAGE_BANNER_EMBLEMS,
    VILLAGE_BANNER_PALETTES,
    VILLAGE_BANNER_PATTERNS,
    sanitizeVillageBanner,
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
    required?: boolean;
    onClose: () => void;
    onSaved?: (banner: VillageBanner) => void;
}

const EMBLEM_NAMES = ['TOWER', 'BLADE', 'OAK', 'STAR', 'MOON', 'HAMMER'];
const PATTERN_NAMES = ['SOLID', 'FESS', 'PALE', 'BEND', 'CHEVRON'];

interface BannerDraft {
    palette: number | null;
    emblem: number | null;
    pattern: number | null;
}

const EMPTY_BANNER_DRAFT: BannerDraft = Object.freeze({
    palette: null,
    emblem: null,
    pattern: null
});

function draftFor(banner: VillageBanner | null): BannerDraft {
    const safe = sanitizeVillageBanner(banner);
    return safe
        ? { palette: safe.palette, emblem: safe.emblem, pattern: safe.pattern }
        : { ...EMPTY_BANNER_DRAFT };
}

function bannerFor(draft: BannerDraft): Required<VillageBanner> | null {
    if (draft.palette === null || draft.emblem === null || draft.pattern === null) return null;
    return { palette: draft.palette, emblem: draft.emblem, pattern: draft.pattern };
}

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
export function BannerPickerModal({ isOpen, userId, required = false, onClose, onSaved }: BannerPickerModalProps) {
    // Missing or partial heraldry is deliberately NOT seeded from the
    // identity-derived rendering fallback. New players must choose every axis.
    const savedBanner = useMemo<VillageBanner | null>(
        () => (isOpen ? sanitizeVillageBanner(Backend.getCachedWorld(userId)?.banner) : null),
        [isOpen, userId]
    );
    const defaultAxes = useMemo(() => bannerAxesOf(villageFlagFor(userId)), [userId]);
    const [choice, setChoice] = useState<BannerDraft>(() => draftFor(savedBanner));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        if (isOpen) {
            setChoice(draftFor(savedBanner));
            setError(null);
        }
    }, [isOpen, savedBanner]);

    if (!isOpen) return null;

    const completedChoice = bannerFor(choice);
    const dirty = Boolean(completedChoice && !villageBannersEqual(completedChoice, savedBanner));

    const pick = (next: Partial<BannerDraft>) => {
        soundSystem.play('click');
        setChoice(prev => ({ ...prev, ...next }));
    };

    // Option tiles still need complete data for the real renderer. These are
    // visual examples only: fallbacks never enter the draft or mark a choice.
    const swatchBanner = (next: Partial<BannerDraft>): Required<VillageBanner> => ({
        palette: next.palette ?? choice.palette ?? defaultAxes.palette,
        emblem: next.emblem ?? choice.emblem ?? defaultAxes.emblem,
        pattern: next.pattern ?? choice.pattern ?? defaultAxes.pattern
    });

    const save = async () => {
        if (busy || !completedChoice) return;
        setBusy(true);
        setError(null);
        try {
            const applied = sanitizeVillageBanner(await Backend.setVillageBanner(userId, completedChoice));
            if (!applied) throw new Error('Banner save returned no complete banner');
            soundSystem.play('confirm');
            onSaved?.(applied);
            onClose();
        } catch {
            setError('The banner could not be raised — try again.');
        } finally {
            setBusy(false);
        }
    };

    const requestClose = () => {
        if (required || busy) return;
        soundSystem.play('uiClose');
        onClose();
    };

    return (
        <div
            className={`modal-overlay ${required ? 'banner-required-overlay' : ''}`}
            onClick={requestClose}
            role="presentation"
        >
            <div
                className="training-modal banner-modal"
                onClick={e => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="banner-picker-title"
            >
                <div className="modal-header">
                    <h2 id="banner-picker-title">{required ? 'Raise Your Banner' : 'Village Banner'}</h2>
                    {!required && (
                        <button className="pxf-close" onClick={requestClose} disabled={busy} aria-label="Close"><span className="sym sym-close small" /></button>
                    )}
                </div>
                <div className="modal-body banner-body">
                    {required && (
                        <div className="banner-required-note">
                            Choose a field, emblem, and pattern before entering your village.
                        </div>
                    )}
                    <div className="banner-preview-row">
                        {completedChoice ? (
                            <BannerSwatch userId={userId} banner={completedChoice} width={192} height={132} scale={3} />
                        ) : (
                            <div className="banner-empty-preview" aria-label="No banner selected">
                                <span>NO BANNER</span>
                                <small>CHOOSE ALL THREE</small>
                            </div>
                        )}
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
                                aria-pressed={choice.palette === palette}
                                aria-label={`Field ${palette + 1}`}
                            >
                                <BannerSwatch userId={userId} banner={swatchBanner({ palette })} width={64} height={48} scale={1.6} />
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
                                aria-pressed={choice.emblem === emblem}
                            >
                                <BannerSwatch userId={userId} banner={swatchBanner({ emblem })} width={64} height={48} scale={1.6} />
                                <span className="banner-cell-name">{EMBLEM_NAMES[emblem]}</span>
                            </button>
                        ))}
                    </div>

                    <div className="banner-section-label">PATTERN</div>
                    <div className="banner-grid">
                        {Array.from({ length: VILLAGE_BANNER_PATTERNS }, (_, pattern) => (
                            <button
                                key={pattern}
                                className={`banner-cell ${choice.pattern === pattern ? 'selected' : ''}`}
                                onClick={() => pick({ pattern })}
                                disabled={busy}
                                aria-pressed={choice.pattern === pattern}
                            >
                                <BannerSwatch userId={userId} banner={swatchBanner({ pattern })} width={64} height={48} scale={1.6} />
                                <span className="banner-cell-name">{PATTERN_NAMES[pattern]}</span>
                            </button>
                        ))}
                    </div>

                    {error && <div className="banner-error">{error}</div>}

                    <div className="banner-actions">
                        <button className="banner-save-btn" onClick={save} disabled={busy || !completedChoice || !dirty}>
                            {busy ? 'RAISING…' : completedChoice ? 'RAISE BANNER' : 'CHOOSE ALL THREE'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
