import { useState } from 'react';

interface BuildingIconProps {
  type: string;
  className?: string;
}

/** Displays a Level-1 portrait generated from the building's baked sprite. */
export function BuildingIcon({ type, className = '' }: BuildingIconProps) {
  const src = `/assets/icons/buildings/${type}.png`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;

  return (
    <span
      className={`icon ${type}-icon ${failed ? '' : 'building-sprite-icon'} ${className}`.trim()}
      aria-hidden="true"
    >
      {!failed && (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setFailedSrc(src)}
        />
      )}
    </span>
  );
}
