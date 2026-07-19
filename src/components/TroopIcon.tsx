import { useEffect, useMemo, useState } from 'react';
import {
  DESIGN_CHANGED_EVENT,
  activeSlot,
  listVariantUnits
} from '../game/renderers/redesign/DesignRegistry';

interface TroopIconProps {
  type: string;
  className?: string;
}

/**
 * Displays a presentation generated from the troop's real baked idle frame.
 * Unresolved design rounds follow the same live A/B/C selection as the
 * battlefield SpriteBank, so the training card can never depict another
 * creature or machine under a recycled CSS silhouette.
 */
export function TroopIcon({ type, className = '' }: TroopIconProps) {
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onDesignChange = (event: Event) => {
      const changed = (event as CustomEvent<{ unit?: string }>).detail?.unit;
      if (!changed || changed === type) setRevision(value => value + 1);
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === `clash.design.${type}`) setRevision(value => value + 1);
    };
    window.addEventListener(DESIGN_CHANGED_EVENT, onDesignChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(DESIGN_CHANGED_EVENT, onDesignChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [type]);

  const src = useMemo(() => {
    const hasVariants = listVariantUnits().some(info => info.unit === type);
    const suffix = hasVariants ? `@${activeSlot(type)}` : '';
    return `/assets/icons/troops/${type}${suffix}.png`;
  }, [type, revision]);

  useEffect(() => setFailed(false), [src]);

  return (
    <span
      className={`icon ${type}-icon ${failed ? '' : 'troop-sprite-icon'} ${className}`.trim()}
      aria-hidden="true"
    >
      {!failed && <img src={src} alt="" draggable={false} onError={() => setFailed(true)} />}
    </span>
  );
}
