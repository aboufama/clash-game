// AUTO-PORTED from the legacy box-shadow rules of accurate-icons.css
// (2026-07-14). Each entry keeps the hand-authored pixel list VERBATIM
// (2px cells; odd offsets = half-cell nudges; rgba() = translucency).
// `base` is the old 2px element background: it paints the (0,0) cell ON
// TOP of every shadow. Shadow list order = CSS box-shadow order: FIRST
// entry paints on top.
export const ICONS = [
  {
    classes: ["warrior-icon"],
    note: "WARRIOR - Barbarian with sword, leather straps, muscular",
    base: "#DEB887",
    px: `
        /* Spiky hair / bald head */
        -2px -18px #CD853F, 0 -18px #DEB887, 2px -18px #CD853F,
        -4px -16px #DEB887, -2px -16px #F5DEB3, 0 -16px #FFE4C4, 2px -16px #F5DEB3, 4px -16px #DEB887,
        /* Angry face */
        -4px -14px #DEB887, -2px -14px #8B0000, 0 -14px #DEB887, 2px -14px #8B0000, 4px -14px #DEB887,
        -4px -12px #CD853F, -2px -12px #DEB887, 0 -12px #8B4513, 2px -12px #DEB887, 4px -12px #CD853F,
        /* Neck */
        -2px -10px #CD853F, 0 -10px #DEB887, 2px -10px #CD853F,
        /* Muscular shoulders & arms */
        -12px -8px #CD853F, -10px -8px #DEB887, -8px -8px #F5DEB3, -6px -8px #DEB887,
        6px -8px #DEB887, 8px -8px #F5DEB3, 10px -8px #DEB887, 12px -8px #CD853F,
        /* Leather straps on chest */
        -4px -8px #5C3317, -2px -8px #DEB887, 0 -8px #5C3317, 2px -8px #DEB887, 4px -8px #5C3317,
        -4px -6px #DEB887, -2px -6px #5C3317, 0 -6px #DEB887, 2px -6px #5C3317, 4px -6px #DEB887,
        /* Arms extended */
        -14px -6px #DEB887, -12px -6px #F5DEB3, -10px -6px #DEB887,
        10px -6px #DEB887, 12px -6px #F5DEB3, 14px -6px #DEB887,
        /* Hands */
        -16px -4px #CD853F, -14px -4px #DEB887,
        /* Sword in right hand */
        14px -4px #DEB887, 16px -4px #696969, 18px -4px #808080, 20px -4px #A9A9A9,
        16px -6px #505050, 18px -6px #696969, 20px -6px #808080, 22px -6px #A9A9A9, 24px -6px #C0C0C0,
        /* Belt */
        -6px -4px #8B4513, -4px -4px #654321, -2px -4px #8B4513, 0 -4px #654321, 2px -4px #8B4513, 4px -4px #654321, 6px -4px #8B4513,
        /* Fur kilt */
        -6px -2px #5C3317, -4px -2px #8B4513, -2px -2px #654321, 0 -2px #8B4513, 2px -2px #654321, 4px -2px #8B4513, 6px -2px #5C3317,
        -6px 0 #3E2723, -4px 0 #5C3317, -2px 0 #8B4513, 0 0 #5C3317, 2px 0 #8B4513, 4px 0 #5C3317, 6px 0 #3E2723,
        /* Legs */
        -4px 2px #CD853F, -2px 2px #DEB887, 2px 2px #DEB887, 4px 2px #CD853F,
        -4px 4px #CD853F, -2px 4px #DEB887, 2px 4px #DEB887, 4px 4px #CD853F,
        /* Boots */
        -6px 6px #3E2723, -4px 6px #5C3317, -2px 6px #3E2723,
        2px 6px #3E2723, 4px 6px #5C3317, 6px 6px #3E2723`
  },
  {
    classes: ["archer-icon"],
    note: "ARCHER - Female archer with pink ponytail, GREEN hooded cloak, bow drawn",
    base: "#228B22",
    px: `
        /* Pink ponytail */
        4px -18px #FF1493, 6px -18px #FF69B4, 8px -16px #FF1493, 10px -14px #FF69B4,
        /* Green Hood */
        -4px -16px #1B5E20, -2px -16px #228B22, 0 -16px #228B22, 2px -16px #1B5E20,
        -6px -14px #1B5E20, -4px -14px #228B22, -2px -14px #2E7D32, 0 -14px #228B22, 2px -14px #1B5E20,
        /* Face */
        -4px -12px #DEB887, -2px -12px #F5DEB3, 0 -12px #DEB887, 2px -12px #F5DEB3, 4px -12px #DEB887,
        /* Eyes */
        -2px -12px #228B22, 2px -12px #228B22,
        /* Green cloak/body */
        -6px -10px #145214, -4px -10px #1B5E20, -2px -10px #228B22, 0 -10px #1B5E20, 2px -10px #228B22, 4px -10px #1B5E20, 6px -10px #145214,
        -6px -8px #0D3D0D, -4px -8px #145214, -2px -8px #1B5E20, 0 -8px #145214, 2px -8px #1B5E20, 4px -8px #145214, 6px -8px #0D3D0D,
        /* Left arm holding bow */
        -10px -8px #DEB887, -12px -6px #DEB887, -14px -6px #CD853F,
        /* BOW (curved on left) */
        -18px -12px #8B4513, -18px -10px #654321, -18px -8px #8B4513, -18px -6px #654321, -18px -4px #8B4513, -18px -2px #654321, -18px 0 #8B4513,
        -16px -14px #654321, -16px 2px #654321,
        /* Bowstring */
        -16px -12px #A9A9A9, -14px -10px #C0C0C0, -12px -8px #A9A9A9, -14px -4px #C0C0C0, -16px -2px #A9A9A9,
        /* Arrow nocked */
        -14px -6px #8B4513, -12px -6px #654321, -10px -6px #8B4513, -8px -6px #C0C0C0, -6px -6px #A9A9A9,
        /* Right arm drawing */
        8px -8px #DEB887, 10px -6px #DEB887, 12px -6px #CD853F,
        /* Lower green body */
        -4px -6px #145214, -2px -6px #1B5E20, 0 -6px #145214, 2px -6px #1B5E20, 4px -6px #145214,
        /* Legs */
        -4px -4px #0D3D0D, -2px -4px #145214, 2px -4px #145214, 4px -4px #0D3D0D,
        -4px -2px #DEB887, -2px -2px #CD853F, 2px -2px #CD853F, 4px -2px #DEB887,
        /* Boots */
        -4px 0 #5C3317, -2px 0 #8B4513, 2px 0 #8B4513, 4px 0 #5C3317,
        -4px 2px #3E2723, -2px 2px #5C3317, 2px 2px #5C3317, 4px 2px #3E2723`
  },
  {
    classes: ["giant-icon"],
    note: "GIANT - Large muscular human with leather vest, dark hair, wooden bat",
    base: "#DEB887",
    px: `
        /* Dark short hair */
        -4px -22px #3A2A1A, -2px -22px #3A2A1A, 0 -22px #3A2A1A, 2px -22px #3A2A1A, 4px -22px #3A2A1A,
        -6px -20px #3A2A1A, -4px -20px #4A3A2A, -2px -20px #3A2A1A, 0 -20px #4A3A2A, 2px -20px #3A2A1A, 4px -20px #4A3A2A, 6px -20px #3A2A1A,
        /* Face */
        -6px -18px #C9A66B, -4px -18px #DEB887, -2px -18px #DEB887, 0 -18px #DEB887, 2px -18px #DEB887, 4px -18px #DEB887, 6px -18px #C9A66B,
        /* Eyes + brow */
        -4px -16px #1A1A1A, -2px -16px #DEB887, 0 -16px #DEB887, 2px -16px #DEB887, 4px -16px #1A1A1A,
        /* Jaw / stubble */
        -6px -14px #C9A66B, -4px -14px #B8956E, -2px -14px #C9A66B, 0 -14px #B8956E, 2px -14px #C9A66B, 4px -14px #B8956E, 6px -14px #C9A66B,
        /* Neck */
        -4px -12px #C9A66B, -2px -12px #DEB887, 0 -12px #DEB887, 2px -12px #DEB887, 4px -12px #C9A66B,
        /* Broad shoulders (skin) + bat on right */
        -16px -10px #C9A66B, -14px -10px #DEB887, -12px -10px #DEB887,
        12px -10px #DEB887, 14px -10px #DEB887, 16px -10px #C9A66B,
        18px -10px #8B6B4A, 18px -12px #8B6B4A, 18px -14px #8B6B4A, 18px -16px #6B4A30, 18px -18px #6B4A30, 18px -20px #6B4A30,
        /* Vest over chest */
        -10px -10px #6B4226, -8px -10px #6B4226, -6px -10px #6B4226, -4px -10px #6B4226, -2px -10px #4A2F1A, 0 -10px #6B4226, 2px -10px #4A2F1A, 4px -10px #6B4226, 6px -10px #6B4226, 8px -10px #6B4226, 10px -10px #6B4226,
        -10px -8px #6B4226, -8px -8px #4A2F1A, -6px -8px #6B4226, -4px -8px #6B4226, -2px -8px #4A2F1A, 0 -8px #6B4226, 2px -8px #4A2F1A, 4px -8px #6B4226, 6px -8px #6B4226, 8px -8px #4A2F1A, 10px -8px #6B4226,
        /* Left arm (skin) */
        -16px -8px #DEB887, -14px -8px #C9A66B, -16px -6px #DEB887, -14px -6px #C9A66B,
        -16px -4px #C9A66B, -14px -4px #C9A66B,
        /* Right arm holding bat */
        16px -8px #DEB887, 14px -8px #C9A66B, 16px -6px #DEB887,
        /* Belt */
        -10px -6px #4A3520, -8px -6px #4A3520, -6px -6px #4A3520, -4px -6px #4A3520, -2px -6px #C9A227, 0 -6px #C9A227, 2px -6px #C9A227, 4px -6px #4A3520, 6px -6px #4A3520, 8px -6px #4A3520, 10px -6px #4A3520,
        /* Pants */
        -8px -4px #5A4A3A, -6px -4px #5A4A3A, -4px -4px #5A4A3A, -2px -4px #5A4A3A, 2px -4px #5A4A3A, 4px -4px #5A4A3A, 6px -4px #5A4A3A, 8px -4px #5A4A3A,
        -8px -2px #4A3A2A, -6px -2px #5A4A3A, -4px -2px #4A3A2A, 4px -2px #4A3A2A, 6px -2px #5A4A3A, 8px -2px #4A3A2A,
        /* Legs */
        -8px 0 #5A4A3A, -6px 0 #4A3A2A, -4px 0 #5A4A3A, 4px 0 #5A4A3A, 6px 0 #4A3A2A, 8px 0 #5A4A3A,
        -8px 2px #4A3A2A, -6px 2px #5A4A3A, -4px 2px #4A3A2A, 4px 2px #4A3A2A, 6px 2px #5A4A3A, 8px 2px #4A3A2A,
        /* Boots */
        -10px 4px #3A2A1A, -8px 4px #3A2A1A, -6px 4px #3A2A1A, -4px 4px #3A2A1A,
        4px 4px #3A2A1A, 6px 4px #3A2A1A, 8px 4px #3A2A1A, 10px 4px #3A2A1A,
        /* Left fist */
        -18px -2px #C9A66B, -16px -2px #DEB887`
  },
  {
    classes: ["wallbreaker-icon"],
    note: "WALL BREAKER - Small guy with barrel of explosives overhead",
    base: "#DEB887",
    px: `
        /* Barrel (brown, above head) */
        -6px -22px #5A3A1A, -4px -22px #6B4A2A, -2px -22px #6B4A2A, 0 -22px #6B4A2A, 2px -22px #6B4A2A, 4px -22px #6B4A2A, 6px -22px #5A3A1A,
        -8px -20px #5A3A1A, -6px -20px #6B4A2A, -4px -20px #7B5A3A, -2px -20px #6B4A2A, 0 -20px #7B5A3A, 2px -20px #6B4A2A, 4px -20px #7B5A3A, 6px -20px #6B4A2A, 8px -20px #5A3A1A,
        -8px -18px #555555, -6px -18px #6B4A2A, -4px -18px #6B4A2A, -2px -18px #6B4A2A, 0 -18px #6B4A2A, 2px -18px #6B4A2A, 4px -18px #6B4A2A, 6px -18px #6B4A2A, 8px -18px #555555,
        /* Fuse + spark */
        0 -24px #3A3A2A, 0 -26px #FFAA00, 2px -26px #FF4400,
        /* Arms reaching up */
        -8px -16px #DEB887, -6px -16px #C9A66B, 6px -16px #C9A66B, 8px -16px #DEB887,
        -8px -14px #DEB887, 8px -14px #DEB887,
        /* Hands on barrel */
        -6px -18px #C9A66B, 6px -18px #C9A66B,
        /* Head (under barrel) */
        -4px -12px #DEB887, -2px -12px #DEB887, 0 -12px #DEB887, 2px -12px #DEB887, 4px -12px #DEB887,
        /* Headband */
        -4px -14px #CC3333, -2px -14px #CC3333, 0 -14px #CC3333, 2px -14px #CC3333, 4px -14px #CC3333,
        /* Eyes */
        -2px -12px #1A1A1A, 2px -12px #1A1A1A,
        /* Body (shirt) */
        -6px -10px #885533, -4px -10px #885533, -2px -10px #885533, 0 -10px #885533, 2px -10px #885533, 4px -10px #885533, 6px -10px #885533,
        -6px -8px #885533, -4px -8px #664422, -2px -8px #885533, 0 -8px #664422, 2px -8px #885533, 4px -8px #664422, 6px -8px #885533,
        -6px -6px #885533, -4px -6px #885533, -2px -6px #885533, 0 -6px #885533, 2px -6px #885533, 4px -6px #885533, 6px -6px #885533,
        /* Legs */
        -4px -4px #664422, -2px -4px #664422, 2px -4px #664422, 4px -4px #664422,
        -4px -2px #664422, -2px -2px #885533, 2px -2px #885533, 4px -2px #664422,
        -4px 0 #664422, -2px 0 #664422, 2px 0 #664422, 4px 0 #664422,
        /* Boots */
        -6px 2px #3A2A1A, -4px 2px #3A2A1A, -2px 2px #3A2A1A,
        2px 2px #3A2A1A, 4px 2px #3A2A1A, 6px 2px #3A2A1A`
  },
  {
    classes: ["ward-icon"],
    note: "WARD - Magical guardian with green shield aura, hooded",
    base: "#32CD32",
    px: `
        /* Hooded head */
        -4px -16px #1B5E20, -2px -16px #228B22, 0 -16px #2E7D32, 2px -16px #228B22, 4px -16px #1B5E20,
        -6px -14px #145214, -4px -14px #1B5E20, -2px -14px #228B22, 0 -14px #2E7D32, 2px -14px #228B22, 4px -14px #1B5E20, 6px -14px #145214,
        /* Face visible under hood */
        -4px -12px #1B5E20, -2px -12px #DEB887, 0 -12px #F5DEB3, 2px -12px #DEB887, 4px -12px #1B5E20,
        /* Green glowing eyes */
        -2px -12px #90EE90, 2px -12px #90EE90,
        /* Body robes */
        -6px -10px #0D3D0D, -4px -10px #145214, -2px -10px #1B5E20, 0 -10px #228B22, 2px -10px #1B5E20, 4px -10px #145214, 6px -10px #0D3D0D,
        -6px -8px #0A2F0A, -4px -8px #0D3D0D, -2px -8px #145214, 0 -8px #1B5E20, 2px -8px #145214, 4px -8px #0D3D0D, 6px -8px #0A2F0A,
        /* Shield aura (glowing green) */
        -12px -6px #90EE90, -10px -6px #32CD32, 10px -6px #32CD32, 12px -6px #90EE90,
        -14px -2px #228B22, -12px -2px #90EE90, 12px -2px #90EE90, 14px -2px #228B22,
        -14px 2px #228B22, -12px 2px #90EE90, 12px 2px #90EE90, 14px 2px #228B22,
        -12px 6px #90EE90, -10px 6px #32CD32, 10px 6px #32CD32, 12px 6px #90EE90,
        /* Arms holding staff */
        -8px -6px #1B5E20, 8px -6px #1B5E20,
        /* Staff with gem */
        -10px -10px #8B4513, -10px -8px #654321, -10px -4px #654321, -10px 0 #8B4513,
        -10px -12px #90EE90, -10px -14px #00FF00,
        /* Lower robes */
        -6px -6px #145214, -4px -6px #1B5E20, -2px -6px #228B22, 0 -6px #1B5E20, 2px -6px #228B22, 4px -6px #1B5E20, 6px -6px #145214,
        -6px -4px #0D3D0D, -4px -4px #145214, -2px -4px #1B5E20, 0 -4px #145214, 2px -4px #1B5E20, 4px -4px #145214, 6px -4px #0D3D0D,
        -4px -2px #0D3D0D, -2px -2px #145214, 0 -2px #0D3D0D, 2px -2px #145214, 4px -2px #0D3D0D,
        /* Feet */
        -4px 0 #3E2723, -2px 0 #5C3317, 2px 0 #5C3317, 4px 0 #3E2723`
  },
  {
    classes: ["recursion-icon"],
    note: "RECURSION - Alien hexagonal blob with split symbol",
    base: "#00FFAA",
    px: `
        /* Outer hexagon shell */
        0 -14px #00AA77, 2px -14px #00FFAA, -2px -14px #00FFAA,
        -6px -12px #00AA77, -4px -12px #00FFAA, -2px -12px #00DDAA, 0 -12px #00FFAA, 2px -12px #00DDAA, 4px -12px #00FFAA, 6px -12px #00AA77,
        -8px -10px #00AA77, -6px -10px #00CC88, -4px -10px #00FFAA, -2px -10px #00FFAA, 0 -10px #00FFAA, 2px -10px #00FFAA, 4px -10px #00FFAA, 6px -10px #00CC88, 8px -10px #00AA77,
        -10px -8px #008866, -8px -8px #00AA77, -6px -8px #00CC88, -4px -8px #00DDAA, -2px -8px #00FFAA, 0 -8px #00FFAA, 2px -8px #00FFAA, 4px -8px #00DDAA, 6px -8px #00CC88, 8px -8px #00AA77, 10px -8px #008866,
        /* Inner hexagon (darker) */
        -4px -6px #007755, -2px -6px #008866, 0 -6px #00AA77, 2px -6px #008866, 4px -6px #007755,
        -10px -6px #008866, -8px -6px #00AA77, -6px -6px #00AA77, 6px -6px #00AA77, 8px -6px #00AA77, 10px -6px #008866,
        /* Central core - white with split cross */
        -2px -4px #007755, 0 -4px #FFFFFF, 2px -4px #007755,
        -10px -4px #00AA77, -8px -4px #00CC88, -6px -4px #008866, 6px -4px #008866, 8px -4px #00CC88, 10px -4px #00AA77,
        -2px -2px #FFFFFF, 0 -2px #00FFAA, 2px -2px #FFFFFF,
        -10px -2px #008866, -8px -2px #00AA77, -6px -2px #007755, 6px -2px #007755, 8px -2px #00AA77, 10px -2px #008866,
        -2px 0 #007755, 0 0 #FFFFFF, 2px 0 #007755,
        /* Lower hexagon */
        -8px 0 #00AA77, -6px 0 #00CC88, -4px 0 #00AA77, 4px 0 #00AA77, 6px 0 #00CC88, 8px 0 #00AA77,
        -6px 2px #00AA77, -4px 2px #00FFAA, -2px 2px #00FFAA, 0 2px #00FFAA, 2px 2px #00FFAA, 4px 2px #00FFAA, 6px 2px #00AA77,
        -4px 4px #00AA77, -2px 4px #00CC88, 0 4px #00FFAA, 2px 4px #00CC88, 4px 4px #00AA77,
        -2px 6px #008866, 0 6px #00AA77, 2px 6px #008866`
  },
  {
    classes: ["ram-icon"],
    note: "RAM - Battering ram siege weapon with log, metal head, wooden frame, wheels",
    base: "#8B4513",
    px: `
        /* Metal ram head (left side) - pointed */
        -20px -4px #505050, -18px -4px #696969, -16px -4px #808080,
        -20px -2px #404040, -18px -2px #505050, -16px -2px #696969, -14px -2px #808080,
        -20px 0 #303030, -18px 0 #404040, -16px 0 #505050, -14px 0 #696969,
        -20px 2px #404040, -18px 2px #505050, -16px 2px #696969, -14px 2px #808080,
        -20px 4px #505050, -18px 4px #696969, -16px 4px #808080,
        /* Main battering log */
        -12px -4px #654321, -10px -4px #8B4513, -8px -4px #A0522D, -6px -4px #8B4513, -4px -4px #A0522D, -2px -4px #8B4513, 0 -4px #A0522D, 2px -4px #8B4513, 4px -4px #A0522D, 6px -4px #8B4513,
        -12px -2px #5C3317, -10px -2px #654321, -8px -2px #8B4513, -6px -2px #A0522D, -4px -2px #8B4513, -2px -2px #A0522D, 0 -2px #8B4513, 2px -2px #A0522D, 4px -2px #8B4513, 6px -2px #654321,
        -12px 0 #5C3317, -10px 0 #654321, -8px 0 #8B4513, -6px 0 #8B4513, -4px 0 #A0522D, -2px 0 #8B4513, 0 0 #A0522D, 2px 0 #8B4513, 4px 0 #8B4513, 6px 0 #654321,
        -12px 2px #5C3317, -10px 2px #654321, -8px 2px #8B4513, -6px 2px #A0522D, -4px 2px #8B4513, -2px 2px #A0522D, 0 2px #8B4513, 2px 2px #A0522D, 4px 2px #8B4513, 6px 2px #654321,
        -12px 4px #654321, -10px 4px #8B4513, -8px 4px #A0522D, -6px 4px #8B4513, -4px 4px #A0522D, -2px 4px #8B4513, 0 4px #A0522D, 2px 4px #8B4513, 4px 4px #A0522D, 6px 4px #8B4513,
        /* Ropes/chains suspending ram */
        -8px -8px #696969, -4px -8px #808080, 0 -8px #696969, 4px -8px #808080,
        -8px -6px #505050, -4px -6px #696969, 0 -6px #505050, 4px -6px #696969,
        /* Wooden frame top */
        -12px -10px #5C3317, -10px -10px #654321, -8px -10px #8B4513, -6px -10px #654321, -4px -10px #8B4513, -2px -10px #654321, 0 -10px #8B4513, 2px -10px #654321, 4px -10px #8B4513, 6px -10px #654321, 8px -10px #5C3317,
        /* Frame supports */
        -12px -8px #5C3317, 8px -8px #5C3317,
        -14px -6px #3E2723, 10px -6px #3E2723,
        /* Wheels left */
        -14px 6px #3E2723, -12px 6px #5C3317, -10px 6px #3E2723,
        -16px 8px #3E2723, -14px 8px #654321, -12px 8px #8B4513, -10px 8px #654321, -8px 8px #3E2723,
        -14px 10px #3E2723, -12px 10px #5C3317, -10px 10px #3E2723,
        /* Wheels right */
        6px 6px #3E2723, 8px 6px #5C3317, 10px 6px #3E2723,
        4px 8px #3E2723, 6px 8px #654321, 8px 8px #8B4513, 10px 8px #654321, 12px 8px #3E2723,
        6px 10px #3E2723, 8px 10px #5C3317, 10px 10px #3E2723`
  },
  {
    classes: ["stormmage-icon"],
    note: "STORMMAGE - Lightning mage STORMMAGE - Blue robed mage with electric lightning staff",
    base: "#4169E1",
    px: `
        /* Hooded head */
        -4px -16px #191970, -2px -16px #0000CD, 0 -16px #4169E1, 2px -16px #0000CD, 4px -16px #191970,
        -6px -14px #0D0D5C, -4px -14px #191970, -2px -14px #0000CD, 0 -14px #4169E1, 2px -14px #0000CD, 4px -14px #191970, 6px -14px #0D0D5C,
        /* Face visible */
        -4px -12px #191970, -2px -12px #DEB887, 0 -12px #F5DEB3, 2px -12px #DEB887, 4px -12px #191970,
        /* Glowing electric blue eyes */
        -2px -12px #00BFFF, 2px -12px #00BFFF,
        /* Lightning bolts above */
        0 -20px #FFFF00, -2px -18px #FFFFFF, 2px -18px #FFFFFF,
        -4px -20px #FFFF00, 4px -20px #FFFF00,
        /* Body robes */
        -6px -10px #0A0A4A, -4px -10px #0D0D5C, -2px -10px #191970, 0 -10px #0000CD, 2px -10px #191970, 4px -10px #0D0D5C, 6px -10px #0A0A4A,
        -6px -8px #080838, -4px -8px #0A0A4A, -2px -8px #0D0D5C, 0 -8px #191970, 2px -8px #0D0D5C, 4px -8px #0A0A4A, 6px -8px #080838,
        /* Electric staff */
        10px -12px #FFFF00, 10px -10px #1E90FF,
        10px -8px #654321, 10px -6px #8B4513, 10px -4px #654321, 10px -2px #8B4513, 10px 0 #654321,
        /* Lightning sparks */
        8px -14px #FFFFFF, 12px -12px #FFFF00, 8px -10px #00BFFF, 12px -8px #FFFFFF,
        /* Arms */
        -8px -6px #0D0D5C, 8px -6px #DEB887,
        /* Lower robes */
        -6px -6px #0D0D5C, -4px -6px #191970, -2px -6px #0000CD, 0 -6px #191970, 2px -6px #0000CD, 4px -6px #191970, 6px -6px #0D0D5C,
        -6px -4px #0A0A4A, -4px -4px #0D0D5C, -2px -4px #191970, 0 -4px #0D0D5C, 2px -4px #191970, 4px -4px #0D0D5C, 6px -4px #0A0A4A,
        -4px -2px #0A0A4A, -2px -2px #0D0D5C, 0 -2px #0A0A4A, 2px -2px #0D0D5C, 4px -2px #0A0A4A,
        /* Feet */
        -4px 0 #3E2723, -2px 0 #5C3317, 2px 0 #5C3317, 4px 0 #3E2723`
  },
  {
    classes: ["golem-icon"],
    note: "GOLEM - Massive stone humanoid with glowing eyes, rock body, thick limbs",
    base: "#696969",
    px: `
        /* Boxy head */
        -4px -20px #808080, -2px -20px #909090, 0 -20px #909090, 2px -20px #909090, 4px -20px #808080,
        -6px -18px #707070, -4px -18px #808080, -2px -18px #909090, 0 -18px #A0A0A0, 2px -18px #909090, 4px -18px #808080, 6px -18px #707070,
        /* Glowing eyes */
        -4px -16px #FFFF00, -2px -16px #FFA500, 2px -16px #FFFF00, 4px -16px #FFA500,
        -6px -16px #606060, 0 -16px #707070, 6px -16px #606060,
        /* Mouth/jaw */
        -4px -14px #505050, -2px -14px #606060, 0 -14px #404040, 2px -14px #606060, 4px -14px #505050,
        /* Neck */
        -2px -12px #505050, 0 -12px #606060, 2px -12px #505050,
        /* Broad shoulders */
        -14px -10px #606060, -12px -10px #707070, -10px -10px #808080, -8px -10px #707070,
        8px -10px #707070, 10px -10px #808080, 12px -10px #707070, 14px -10px #606060,
        -4px -10px #606060, -2px -10px #707070, 0 -10px #808080, 2px -10px #707070, 4px -10px #606060,
        /* Left arm */
        -16px -8px #505050, -14px -8px #606060, -12px -8px #707070, -10px -8px #606060,
        -18px -6px #404040, -16px -6px #505050, -14px -6px #606060, -12px -6px #505050,
        -18px -4px #505050, -16px -4px #606060, -14px -4px #505050,
        -18px -2px #404040, -16px -2px #505050, -14px -2px #404040,
        /* Left fist */
        -20px 0 #505050, -18px 0 #606060, -16px 0 #707070, -14px 0 #606060,
        -20px 2px #404040, -18px 2px #505050, -16px 2px #606060, -14px 2px #505050,
        /* Right arm */
        10px -8px #606060, 12px -8px #707070, 14px -8px #606060, 16px -8px #505050,
        12px -6px #505050, 14px -6px #606060, 16px -6px #505050, 18px -6px #404040,
        14px -4px #505050, 16px -4px #606060, 18px -4px #505050,
        14px -2px #404040, 16px -2px #505050, 18px -2px #404040,
        /* Right fist */
        14px 0 #606060, 16px 0 #707070, 18px 0 #606060, 20px 0 #505050,
        14px 2px #505050, 16px 2px #606060, 18px 2px #505050, 20px 2px #404040,
        /* Chest/torso with rocky cracks */
        -8px -8px #606060, -6px -8px #707070, -4px -8px #808080, -2px -8px #707070, 0 -8px #808080, 2px -8px #707070, 4px -8px #808080, 6px -8px #707070, 8px -8px #606060,
        -8px -6px #505050, -6px -6px #606060, -4px -6px #707070, -2px -6px #404040, 0 -6px #707070, 2px -6px #404040, 4px -6px #707070, 6px -6px #606060, 8px -6px #505050,
        -8px -4px #505050, -6px -4px #606060, -4px -4px #505050, -2px -4px #606060, 0 -4px #707070, 2px -4px #606060, 4px -4px #505050, 6px -4px #606060, 8px -4px #505050,
        -8px -2px #404040, -6px -2px #505050, -4px -2px #606060, -2px -2px #505050, 0 -2px #606060, 2px -2px #505050, 4px -2px #606060, 6px -2px #505050, 8px -2px #404040,
        /* Lower torso */
        -6px 0 #404040, -4px 0 #505050, -2px 0 #606060, 0 0 #505050, 2px 0 #606060, 4px 0 #505050, 6px 0 #404040,
        /* Left leg */
        -6px 2px #404040, -4px 2px #505050, -2px 2px #404040,
        -6px 4px #303030, -4px 4px #404040, -2px 4px #505050,
        -8px 6px #303030, -6px 6px #404040, -4px 6px #505050, -2px 6px #404040,
        -8px 8px #202020, -6px 8px #303030, -4px 8px #404040, -2px 8px #303030,
        /* Right leg */
        2px 2px #404040, 4px 2px #505050, 6px 2px #404040,
        2px 4px #505050, 4px 4px #404040, 6px 4px #303030,
        2px 6px #404040, 4px 6px #505050, 6px 6px #404040, 8px 6px #303030,
        2px 8px #303030, 4px 8px #404040, 6px 8px #303030, 8px 8px #202020`
  },
  {
    classes: ["icegolem-icon"],
    note: "ICE GOLEM - Icy recolor of the golem silhouette (same gap-free cell layout); placeholder until the icy redesign ships its own icon",
    base: "#6FB2D0",
    px: `
        /* Boxy head */
        -4px -20px #9FD3E8, -2px -20px #B4DEEF, 0 -20px #B4DEEF, 2px -20px #B4DEEF, 4px -20px #9FD3E8,
        -6px -18px #88C4DD, -4px -18px #9FD3E8, -2px -18px #B4DEEF, 0 -18px #C9E8F5, 2px -18px #B4DEEF, 4px -18px #9FD3E8, 6px -18px #88C4DD,
        /* Glowing eyes */
        -4px -16px #EAFFFF, -2px -16px #66D9FF, 2px -16px #EAFFFF, 4px -16px #66D9FF,
        -6px -16px #6FB2D0, 0 -16px #88C4DD, 6px -16px #6FB2D0,
        /* Mouth/jaw */
        -4px -14px #5A9EC0, -2px -14px #6FB2D0, 0 -14px #468AAE, 2px -14px #6FB2D0, 4px -14px #5A9EC0,
        /* Neck */
        -2px -12px #5A9EC0, 0 -12px #6FB2D0, 2px -12px #5A9EC0,
        /* Broad shoulders */
        -14px -10px #6FB2D0, -12px -10px #88C4DD, -10px -10px #9FD3E8, -8px -10px #88C4DD,
        8px -10px #88C4DD, 10px -10px #9FD3E8, 12px -10px #88C4DD, 14px -10px #6FB2D0,
        -4px -10px #6FB2D0, -2px -10px #88C4DD, 0 -10px #9FD3E8, 2px -10px #88C4DD, 4px -10px #6FB2D0,
        /* Left arm */
        -16px -8px #5A9EC0, -14px -8px #6FB2D0, -12px -8px #88C4DD, -10px -8px #6FB2D0,
        -18px -6px #468AAE, -16px -6px #5A9EC0, -14px -6px #6FB2D0, -12px -6px #5A9EC0,
        -18px -4px #5A9EC0, -16px -4px #6FB2D0, -14px -4px #5A9EC0,
        -18px -2px #468AAE, -16px -2px #5A9EC0, -14px -2px #468AAE,
        /* Left fist */
        -20px 0 #5A9EC0, -18px 0 #6FB2D0, -16px 0 #88C4DD, -14px 0 #6FB2D0,
        -20px 2px #468AAE, -18px 2px #5A9EC0, -16px 2px #6FB2D0, -14px 2px #5A9EC0,
        /* Right arm */
        10px -8px #6FB2D0, 12px -8px #88C4DD, 14px -8px #6FB2D0, 16px -8px #5A9EC0,
        12px -6px #5A9EC0, 14px -6px #6FB2D0, 16px -6px #5A9EC0, 18px -6px #468AAE,
        14px -4px #5A9EC0, 16px -4px #6FB2D0, 18px -4px #5A9EC0,
        14px -2px #468AAE, 16px -2px #5A9EC0, 18px -2px #468AAE,
        /* Right fist */
        14px 0 #6FB2D0, 16px 0 #88C4DD, 18px 0 #6FB2D0, 20px 0 #5A9EC0,
        14px 2px #5A9EC0, 16px 2px #6FB2D0, 18px 2px #5A9EC0, 20px 2px #468AAE,
        /* Chest/torso with rocky cracks */
        -8px -8px #6FB2D0, -6px -8px #88C4DD, -4px -8px #9FD3E8, -2px -8px #88C4DD, 0 -8px #9FD3E8, 2px -8px #88C4DD, 4px -8px #9FD3E8, 6px -8px #88C4DD, 8px -8px #6FB2D0,
        -8px -6px #5A9EC0, -6px -6px #6FB2D0, -4px -6px #88C4DD, -2px -6px #468AAE, 0 -6px #88C4DD, 2px -6px #468AAE, 4px -6px #88C4DD, 6px -6px #6FB2D0, 8px -6px #5A9EC0,
        -8px -4px #5A9EC0, -6px -4px #6FB2D0, -4px -4px #5A9EC0, -2px -4px #6FB2D0, 0 -4px #88C4DD, 2px -4px #6FB2D0, 4px -4px #5A9EC0, 6px -4px #6FB2D0, 8px -4px #5A9EC0,
        -8px -2px #468AAE, -6px -2px #5A9EC0, -4px -2px #6FB2D0, -2px -2px #5A9EC0, 0 -2px #6FB2D0, 2px -2px #5A9EC0, 4px -2px #6FB2D0, 6px -2px #5A9EC0, 8px -2px #468AAE,
        /* Lower torso */
        -6px 0 #468AAE, -4px 0 #5A9EC0, -2px 0 #6FB2D0, 0 0 #5A9EC0, 2px 0 #6FB2D0, 4px 0 #5A9EC0, 6px 0 #468AAE,
        /* Left leg */
        -6px 2px #468AAE, -4px 2px #5A9EC0, -2px 2px #468AAE,
        -6px 4px #35759A, -4px 4px #468AAE, -2px 4px #5A9EC0,
        -8px 6px #35759A, -6px 6px #468AAE, -4px 6px #5A9EC0, -2px 6px #468AAE,
        -8px 8px #266185, -6px 8px #35759A, -4px 8px #468AAE, -2px 8px #35759A,
        /* Right leg */
        2px 2px #468AAE, 4px 2px #5A9EC0, 6px 2px #468AAE,
        2px 4px #5A9EC0, 4px 4px #468AAE, 6px 4px #35759A,
        2px 6px #468AAE, 4px 6px #5A9EC0, 6px 6px #468AAE, 8px 6px #35759A,
        2px 8px #35759A, 4px 8px #468AAE, 6px 8px #35759A, 8px 8px #266185`
  },
  {
    classes: ["sharpshooter-icon"],
    note: "SHARPSHOOTER - Elite hooded crossbow marksman with scope",
    base: "#228B22",
    px: `
        /* Hood/head */
        -4px -18px #1B5E20, -2px -18px #228B22, 0 -18px #228B22, 2px -18px #1B5E20,
        -6px -16px #145214, -4px -16px #1B5E20, -2px -16px #228B22, 0 -16px #2E7D32, 2px -16px #228B22, 4px -16px #1B5E20, 6px -16px #145214,
        /* Face peeking from hood */
        -4px -14px #1B5E20, -2px -14px #DEB887, 0 -14px #F5DEB3, 2px -14px #DEB887, 4px -14px #1B5E20,
        /* Eyes */
        -2px -14px #654321, 2px -14px #654321,
        /* Dark green cloak body */
        -6px -12px #145214, -4px -12px #1B5E20, -2px -12px #228B22, 0 -12px #1B5E20, 2px -12px #228B22, 4px -12px #1B5E20, 6px -12px #145214,
        -6px -10px #0D3D0D, -4px -10px #145214, -2px -10px #1B5E20, 0 -10px #228B22, 2px -10px #1B5E20, 4px -10px #145214, 6px -10px #0D3D0D,
        /* Arms holding crossbow */
        -10px -10px #DEB887, -8px -8px #DEB887, -10px -8px #145214,
        8px -10px #DEB887, 10px -10px #145214,
        /* CROSSBOW (held horizontally) */
        -18px -8px #654321, -16px -8px #8B4513, -14px -8px #654321, -12px -8px #8B4513,
        /* Crossbow bow arms */
        -18px -12px #5C3317, -16px -12px #654321, -16px -14px #5C3317,
        -18px -4px #5C3317, -16px -4px #654321, -16px -2px #5C3317,
        /* Bowstring */
        -14px -12px #A9A9A9, -12px -10px #C0C0C0, -12px -8px #A9A9A9, -12px -6px #C0C0C0, -14px -4px #A9A9A9,
        /* Scope on crossbow */
        -10px -10px #505050, -8px -10px #696969, -6px -10px #87CEEB,
        /* Bolt loaded */
        -10px -8px #8B4513, -8px -8px #654321, -6px -8px #C0C0C0,
        /* Body/torso */
        -6px -8px #0D3D0D, -4px -8px #145214, -2px -8px #1B5E20, 0 -8px #145214, 2px -8px #1B5E20, 4px -8px #145214, 6px -8px #0D3D0D,
        /* Quiver on back */
        6px -12px #5C3317, 8px -12px #654321, 10px -12px #5C3317,
        6px -10px #654321, 8px -10px #8B4513, 10px -10px #654321,
        8px -14px #C0C0C0, 10px -14px #C0C0C0, 12px -14px #C0C0C0,
        /* Belt with pouches */
        -6px -6px #5C3317, -4px -6px #654321, -2px -6px #8B4513, 0 -6px #654321, 2px -6px #8B4513, 4px -6px #654321, 6px -6px #5C3317,
        /* Legs */
        -4px -4px #0D3D0D, -2px -4px #145214, 2px -4px #145214, 4px -4px #0D3D0D,
        -4px -2px #0D3D0D, -2px -2px #145214, 2px -2px #145214, 4px -2px #0D3D0D,
        /* Boots */
        -6px 0 #3E2723, -4px 0 #5C3317, -2px 0 #3E2723,
        2px 0 #3E2723, 4px 0 #5C3317, 6px 0 #3E2723`
  },
  {
    classes: ["mobilemortar-icon"],
    note: "MOBILEMORTAR - Soldier dragging mortar on wheeled cart",
    base: "#696969",
    px: `
        /* SOLDIER (on left, pulling) */
        /* Helmet */
        -18px -14px #505050, -16px -14px #606060, -14px -14px #505050,
        -18px -12px #404040, -16px -12px #505050, -14px -12px #404040,
        /* Face */
        -16px -10px #DEB887, -14px -10px #F5DEB3,
        /* Body/torso */
        -18px -8px #8B0000, -16px -8px #B22222, -14px -8px #8B0000,
        -18px -6px #660000, -16px -6px #8B0000, -14px -6px #660000,
        /* Arms pulling rope */
        -20px -6px #DEB887, -12px -6px #DEB887,
        -12px -4px #8B4513, -10px -4px #A0522D, -8px -4px #8B4513,
        /* Legs */
        -18px -4px #4A4A4A, -16px -4px #5A5A5A, -14px -4px #4A4A4A,
        -18px -2px #3A3A3A, -14px -2px #3A3A3A,
        -18px 0 #2A2A2A, -14px 0 #2A2A2A,
        /* ROPE connecting to cart */
        -6px -4px #A0522D, -4px -2px #8B4513, -2px 0 #A0522D,
        /* MORTAR on cart (right side) */
        /* Mortar barrel opening */
        2px -12px #303030, 4px -12px #404040, 6px -12px #505050, 8px -12px #404040, 10px -12px #303030,
        0 -10px #404040, 2px -10px #1A1A1A, 4px -10px #0A0A0A, 6px -10px #0A0A0A, 8px -10px #1A1A1A, 10px -10px #404040, 12px -10px #303030,
        /* Mortar body */
        0 -8px #505050, 2px -8px #606060, 4px -8px #696969, 6px -8px #808080, 8px -8px #696969, 10px -8px #606060, 12px -8px #505050,
        0 -6px #404040, 2px -6px #505050, 4px -6px #606060, 6px -6px #696969, 8px -6px #606060, 10px -6px #505050, 12px -6px #404040,
        /* Mortar base */
        0 -4px #303030, 2px -4px #404040, 4px -4px #505050, 6px -4px #606060, 8px -4px #505050, 10px -4px #404040, 12px -4px #303030,
        /* Cart platform */
        -2px -2px #5C3317, 0 -2px #654321, 2px -2px #8B4513, 4px -2px #654321, 6px -2px #8B4513, 8px -2px #654321, 10px -2px #8B4513, 12px -2px #654321, 14px -2px #5C3317,
        -2px 0 #3E2723, 0 0 #5C3317, 2px 0 #654321, 4px 0 #5C3317, 6px 0 #654321, 8px 0 #5C3317, 10px 0 #654321, 12px 0 #5C3317, 14px 0 #3E2723,
        /* Cart wheels (left) */
        -2px 2px #3E2723, 0 2px #5C3317, 2px 2px #3E2723,
        -4px 4px #3E2723, -2px 4px #654321, 0 4px #8B4513, 2px 4px #654321, 4px 4px #3E2723,
        -2px 6px #3E2723, 0 6px #5C3317, 2px 6px #3E2723,
        /* Cart wheels (right) */
        10px 2px #3E2723, 12px 2px #5C3317, 14px 2px #3E2723,
        8px 4px #3E2723, 10px 4px #654321, 12px 4px #8B4513, 14px 4px #654321, 16px 4px #3E2723,
        10px 6px #3E2723, 12px 6px #5C3317, 14px 6px #3E2723`
  },
  {
    classes: ["davincitank-icon"],
    note: "DA VINCI TANK - Leonardo's iconic conical armored war machine with cannons",
    base: "#C9A07A",
    px: `
        /* Top finial/spike */
        0 -20px #505050, 0 -18px #606060,
        /* Upper turret cone */
        -2px -16px #C9A07A, 0 -16px #DAB898, 2px -16px #C9A07A,
        -4px -14px #B08560, -2px -14px #C9A07A, 0 -14px #DAB898, 2px -14px #C9A07A, 4px -14px #B08560,
        /* Upper metal band */
        -6px -12px #505050, -4px -12px #606060, -2px -12px #505050, 0 -12px #606060, 2px -12px #505050, 4px -12px #606060, 6px -12px #505050,
        /* Middle cone section */
        -8px -10px #9A7050, -6px -10px #B08560, -4px -10px #C9A07A, -2px -10px #B08560, 0 -10px #C9A07A, 2px -10px #B08560, 4px -10px #C9A07A, 6px -10px #B08560, 8px -10px #9A7050,
        -10px -8px #8A6548, -8px -8px #9A7050, -6px -8px #B08560, -4px -8px #C9A07A, -2px -8px #B08560, 0 -8px #C9A07A, 2px -8px #B08560, 4px -8px #C9A07A, 6px -8px #B08560, 8px -8px #9A7050, 10px -8px #8A6548,
        /* Lower metal band with rivets */
        -12px -6px #404040, -10px -6px #505050, -8px -6px #606060, -6px -6px #505050, -4px -6px #606060, -2px -6px #505050, 0 -6px #606060, 2px -6px #505050, 4px -6px #606060, 6px -6px #505050, 8px -6px #606060, 10px -6px #505050, 12px -6px #404040,
        /* Lower cone (widest) */
        -14px -4px #8A6548, -12px -4px #9A7050, -10px -4px #B08560, -8px -4px #C9A07A, -6px -4px #B08560, -4px -4px #C9A07A, -2px -4px #B08560, 0 -4px #C9A07A, 2px -4px #B08560, 4px -4px #C9A07A, 6px -4px #B08560, 8px -4px #C9A07A, 10px -4px #B08560, 12px -4px #9A7050, 14px -4px #8A6548,
        /* Cannon barrels sticking out */
        -18px -2px #1A1A1A, -16px -2px #303030,
        18px -2px #1A1A1A, 16px -2px #303030,
        -20px 0 #1A1A1A, -18px 0 #303030,
        20px 0 #1A1A1A, 18px 0 #303030,
        /* Base platform */
        -14px -2px #654321, -12px -2px #8B4513, -10px -2px #9A7050, -8px -2px #8B4513, -6px -2px #9A7050, -4px -2px #8B4513, -2px -2px #9A7050, 0 -2px #8B4513, 2px -2px #9A7050, 4px -2px #8B4513, 6px -2px #9A7050, 8px -2px #8B4513, 10px -2px #9A7050, 12px -2px #8B4513, 14px -2px #654321,
        -12px 0 #5C3317, -10px 0 #654321, -8px 0 #8B4513, -6px 0 #654321, -4px 0 #8B4513, -2px 0 #654321, 0 0 #8B4513, 2px 0 #654321, 4px 0 #8B4513, 6px 0 #654321, 8px 0 #8B4513, 10px 0 #654321, 12px 0 #5C3317,
        /* Ground base */
        -10px 2px #3E2723, -8px 2px #5C3317, -6px 2px #654321, -4px 2px #5C3317, -2px 2px #654321, 0 2px #5C3317, 2px 2px #654321, 4px 2px #5C3317, 6px 2px #654321, 8px 2px #5C3317, 10px 2px #3E2723`
  },
  {
    classes: ["phalanx-icon"],
    note: "PHALANX - Roman Testudo Formation (3x3 shield wall)",
    base: "#CC3333",
    px: `
        /* Back row shields (3) */
        -10px -12px #CC3333, -8px -12px #CC3333, -6px -12px #D4A84B,
        0 -12px #CC3333, -2px -12px #CC3333, 2px -12px #D4A84B,
        10px -12px #CC3333, 8px -12px #CC3333, 6px -12px #D4A84B,
        /* Middle row shields (3) */
        -10px -6px #CC3333, -8px -6px #AA2222, -6px -6px #D4A84B,
        0 -6px #CC3333, -2px -6px #AA2222, 2px -6px #D4A84B,
        10px -6px #CC3333, 8px -6px #AA2222, 6px -6px #D4A84B,
        /* Front row shields (3) */
        -10px 0 #CC3333, -8px 0 #AA2222, -6px 0 #D4A84B,
        0 0 #CC3333, -2px 0 #AA2222, 2px 0 #D4A84B,
        10px 0 #CC3333, 8px 0 #AA2222, 6px 0 #D4A84B,
        /* Gold shield bosses */
        -8px -10px #FFD700, 0 -10px #FFD700, 8px -10px #FFD700,
        -8px -4px #FFD700, 0 -4px #FFD700, 8px -4px #FFD700,
        -8px 2px #FFD700, 0 2px #FFD700, 8px 2px #FFD700,
        /* Spear tips sticking out top */
        -8px -16px #666677, 0 -16px #666677, 8px -16px #666677,
        -8px -18px #555566, 0 -18px #555566, 8px -18px #555566,
        /* Banner pole */
        0 -20px #5D4E37,
        /* Banner */
        -2px -22px #CC3333, 0 -22px #FFD700, 2px -22px #CC3333,
        /* Soldier legs visible at bottom */
        -10px 4px #BB2222, -8px 4px #BB2222,
        0 4px #BB2222, 2px 4px #BB2222,
        10px 4px #BB2222, 8px 4px #BB2222`
  },
  {
    classes: ["town_hall-icon"],
    note: "TOWN HALL - Grand building with gold dome, red roof, stone walls",
    base: "#FFD700",
    px: `
        /* Flag pole and flag */
        0 -20px #DC143C, 2px -20px #FF0000, 4px -20px #DC143C,
        0 -18px #DC143C, 2px -18px #DC143C,
        0 -16px #696969, 0 -14px #696969,
        /* Gold dome top */
        -2px -12px #FFFACD, 0 -12px #FFF, 2px -12px #FFFACD,
        -4px -10px #FFD700, -2px -10px #FFFACD, 0 -10px #FFF, 2px -10px #FFFACD, 4px -10px #FFD700,
        -6px -8px #DAA520, -4px -8px #FFD700, -2px -8px #FFFACD, 0 -8px #FFFACD, 2px -8px #FFFACD, 4px -8px #FFD700, 6px -8px #DAA520,
        /* Red roof layer */
        -10px -6px #8B0000, -8px -6px #B22222, -6px -6px #DC143C, -4px -6px #DC143C, -2px -6px #FF4500, 0 -6px #FF4500, 2px -6px #FF4500, 4px -6px #DC143C, 6px -6px #DC143C, 8px -6px #B22222, 10px -6px #8B0000,
        -12px -4px #660000, -10px -4px #8B0000, -8px -4px #B22222, -6px -4px #DC143C, -4px -4px #DC143C, -2px -4px #DC143C, 0 -4px #DC143C, 2px -4px #DC143C, 4px -4px #DC143C, 6px -4px #DC143C, 8px -4px #B22222, 10px -4px #8B0000, 12px -4px #660000,
        /* Stone walls */
        -12px -2px #8B4513, -10px -2px #A0522D, -8px -2px #D2691E, -6px -2px #CD853F, -4px -2px #D2691E, -2px -2px #CD853F, 0 -2px #DEB887, 2px -2px #CD853F, 4px -2px #D2691E, 6px -2px #CD853F, 8px -2px #D2691E, 10px -2px #A0522D, 12px -2px #8B4513,
        -12px 0 #654321, -10px 0 #8B4513, -8px 0 #A0522D, -6px 0 #CD853F, -4px 0 #D2691E, -2px 0 #000, 0 0 #2A1A0A, 2px 0 #000, 4px 0 #D2691E, 6px 0 #CD853F, 8px 0 #A0522D, 10px 0 #8B4513, 12px 0 #654321,
        -12px 2px #5C3317, -10px 2px #654321, -8px 2px #8B4513, -6px 2px #A0522D, -4px 2px #8B4513, -2px 2px #3E2723, 0 2px #2A1A0A, 2px 2px #3E2723, 4px 2px #8B4513, 6px 2px #A0522D, 8px 2px #8B4513, 10px 2px #654321, 12px 2px #5C3317,
        /* Windows */
        -8px 0 #87CEEB, -6px 0 #B0E0E6, 6px 0 #87CEEB, 8px 0 #B0E0E6,
        /* Stone foundation */
        -14px 4px #404040, -12px 4px #505050, -10px 4px #606060, -8px 4px #505050, -6px 4px #606060, -4px 4px #505050, -2px 4px #606060, 0 4px #505050, 2px 4px #606060, 4px 4px #505050, 6px 4px #606060, 8px 4px #505050, 10px 4px #606060, 12px 4px #505050, 14px 4px #404040,
        -14px 6px #303030, -12px 6px #404040, -10px 6px #505050, -8px 6px #404040, -6px 6px #505050, -4px 6px #404040, -2px 6px #505050, 0 6px #404040, 2px 6px #505050, 4px 6px #404040, 6px 6px #505050, 8px 6px #404040, 10px 6px #505050, 12px 6px #404040, 14px 6px #303030`
  },
  {
    classes: ["cannon-icon"],
    note: "CANNON - Detailed artillery cannon on wooden carriage with wheels",
    base: "#505050",
    px: `
        /* Barrel muzzle */
        -2px -18px #404040, 0 -18px #505050, 2px -18px #404040,
        -4px -16px #505050, -2px -16px #696969, 0 -16px #808080, 2px -16px #696969, 4px -16px #505050,
        /* Long barrel body */
        -4px -14px #404040, -2px -14px #606060, 0 -14px #808080, 2px -14px #606060, 4px -14px #404040,
        -4px -12px #505050, -2px -12px #696969, 0 -12px #A9A9A9, 2px -12px #696969, 4px -12px #505050,
        -4px -10px #505050, -2px -10px #707070, 0 -10px #909090, 2px -10px #707070, 4px -10px #505050,
        -4px -8px #404040, -2px -8px #606060, 0 -8px #808080, 2px -8px #606060, 4px -8px #404040,
        /* Barrel base ring */
        -6px -6px #404040, -4px -6px #505050, -2px -6px #606060, 0 -6px #696969, 2px -6px #606060, 4px -6px #505050, 6px -6px #404040,
        /* Wooden carriage */
        -8px -4px #8B4513, -6px -4px #A0522D, -4px -4px #D2691E, -2px -4px #CD853F, 0 -4px #D2691E, 2px -4px #CD853F, 4px -4px #D2691E, 6px -4px #A0522D, 8px -4px #8B4513,
        -10px -2px #654321, -8px -2px #8B4513, -6px -2px #A0522D, -4px -2px #8B4513, -2px -2px #A0522D, 0 -2px #8B4513, 2px -2px #A0522D, 4px -2px #8B4513, 6px -2px #A0522D, 8px -2px #8B4513, 10px -2px #654321,
        /* Axle */
        -14px 0 #404040, -12px 0 #505050, -10px 0 #404040, 10px 0 #404040, 12px 0 #505050, 14px 0 #404040,
        /* Left wheel */
        -16px -4px #3A2A1A, -14px -4px #5C3317, -12px -4px #3A2A1A,
        -18px -2px #3A2A1A, -16px -2px #654321, -14px -2px #8B4513, -12px -2px #654321, -10px -2px #3A2A1A,
        -18px 0 #3A2A1A, -16px 0 #8B4513, -14px 0 #A0522D, -12px 0 #8B4513, -10px 0 #3A2A1A,
        -18px 2px #3A2A1A, -16px 2px #654321, -14px 2px #8B4513, -12px 2px #654321, -10px 2px #3A2A1A,
        -16px 4px #3A2A1A, -14px 4px #5C3317, -12px 4px #3A2A1A,
        /* Right wheel */
        12px -4px #3A2A1A, 14px -4px #5C3317, 16px -4px #3A2A1A,
        10px -2px #3A2A1A, 12px -2px #654321, 14px -2px #8B4513, 16px -2px #654321, 18px -2px #3A2A1A,
        10px 0 #3A2A1A, 12px 0 #8B4513, 14px 0 #A0522D, 16px 0 #8B4513, 18px 0 #3A2A1A,
        10px 2px #3A2A1A, 12px 2px #654321, 14px 2px #8B4513, 16px 2px #654321, 18px 2px #3A2A1A,
        12px 4px #3A2A1A, 14px 4px #5C3317, 16px 4px #3A2A1A`
  },
  {
    classes: ["jukebox-icon"],
    note: "JUKEBOX - Carved music cabinet with a brass horn",
    base: "#6d4230",
    px: `
        /* Brass horn */
        8px -14px #d8b13a, 10px -14px #f2d268, 12px -14px #f2d268, 14px -14px #d8b13a,
        8px -12px #f2d268, 10px -12px #8a6a1e, 12px -12px #8a6a1e, 14px -12px #f2d268,
        6px -10px #d8b13a, 8px -10px #f2d268, 10px -10px #8a6a1e, 12px -10px #f2d268, 14px -10px #d8b13a,
        4px -8px #b8912e, 6px -8px #d8b13a,
        /* Arched crown */
        -6px -12px #7e5138, -4px -12px #8a5c40, -2px -12px #8a5c40, 0 -12px #8a5c40, 2px -12px #7e5138,
        -8px -10px #6d4230, -6px -10px #7e5138, -4px -10px #8a5c40, -2px -10px #8a5c40, 0 -10px #8a5c40, 2px -10px #7e5138, 4px -10px #6d4230,
        /* Gold trim */
        -8px -8px #c9a227, -6px -8px #c9a227, -4px -8px #c9a227, -2px -8px #c9a227, 0 -8px #c9a227, 2px -8px #c9a227, 4px -8px #c9a227,
        /* Cabinet with glowing panel */
        -8px -6px #6d4230, -6px -6px #2a1a30, -4px -6px #c98aff, -2px -6px #d8a8ff, 0 -6px #c98aff, 2px -6px #2a1a30, 4px -6px #6d4230,
        -8px -4px #6d4230, -6px -4px #2a1a30, -4px -4px #9a5abe, -2px -4px #c98aff, 0 -4px #9a5abe, 2px -4px #2a1a30, 4px -4px #6d4230,
        -8px -2px #6d4230, -6px -2px #2a1a30, -4px -2px #c98aff, -2px -2px #d8a8ff, 0 -2px #c98aff, 2px -2px #2a1a30, 4px -2px #6d4230,
        -8px 0 #6d4230, -6px 0 #2a1a30, -4px 0 #9a5abe, -2px 0 #c98aff, 0 0 #9a5abe, 2px 0 #2a1a30, 4px 0 #6d4230,
        /* Crank */
        -10px -4px #c9a227, -12px -5px #8a6a1e,
        /* Base */
        -8px 2px #5c3826, -6px 2px #6d4230, -4px 2px #6d4230, -2px 2px #6d4230, 0 2px #6d4230, 2px 2px #6d4230, 4px 2px #5c3826,
        -10px 4px #4a2c1e, -8px 4px #5c3826, -6px 4px #5c3826, -4px 4px #5c3826, -2px 4px #5c3826, 0 4px #5c3826, 2px 4px #5c3826, 4px 4px #5c3826, 6px 4px #4a2c1e,
        /* Ground shadow */
        -6px 6px #2e3034, -4px 6px #2e3034, -2px 6px #2e3034, 0 6px #2e3034, 2px 6px #2e3034,
        /* Floating note */
        -12px -14px #d8a8ff, -12px -12px #d8a8ff, -10px -11px #d8a8ff`
  },
  {
    classes: ["frostfall-icon"],
    note: "FROSTFALL MONOLITH - Towering ice crystal on a frosted stone base",
    base: "#9fd8f2",
    px: `
        /* Crystal tip */
        0 -16px #e8f6ff,
        -2px -14px #bfe6f8, 0 -14px #e8f6ff, 2px -14px #bfe6f8,
        /* Upper shaft */
        -2px -12px #9fd8f2, 0 -12px #d4eefc, 2px -12px #9fd8f2,
        -4px -10px #7fc4e8, -2px -10px #bfe6f8, 0 -10px #e8f6ff, 2px -10px #9fd8f2, 4px -10px #7fc4e8,
        -4px -8px #7fc4e8, -2px -8px #9fd8f2, 0 -8px #d4eefc, 2px -8px #9fd8f2, 4px -8px #6ab0d8,
        /* Mid shaft with inner glow */
        -6px -6px #5a9cc8, -4px -6px #7fc4e8, -2px -6px #bfe6f8, 0 -6px #e8f6ff, 2px -6px #9fd8f2, 4px -6px #7fc4e8, 6px -6px #5a9cc8,
        -6px -4px #5a9cc8, -4px -4px #7fc4e8, -2px -4px #9fd8f2, 0 -4px #d4eefc, 2px -4px #7fc4e8, 4px -4px #6ab0d8, 6px -4px #4a88b4,
        -6px -2px #4a88b4, -4px -2px #6ab0d8, -2px -2px #9fd8f2, 0 -2px #bfe6f8, 2px -2px #7fc4e8, 4px -2px #5a9cc8, 6px -2px #4a88b4,
        /* Base of the crystal */
        -4px 0 #4a88b4, -2px 0 #6ab0d8, 0 0 #7fc4e8, 2px 0 #5a9cc8, 4px 0 #4a88b4,
        /* Frosted stone plinth */
        -8px 2px #8a97a4, -6px 2px #a8b4c0, -4px 2px #c4ccd6, -2px 2px #c4ccd6, 0 2px #c4ccd6, 2px 2px #a8b4c0, 4px 2px #a8b4c0, 6px 2px #8a97a4, 8px 2px #8a97a4,
        -10px 4px #6d7884, -8px 4px #8a97a4, -6px 4px #a8b4c0, -4px 4px #a8b4c0, -2px 4px #a8b4c0, 0 4px #a8b4c0, 2px 4px #8a97a4, 4px 4px #8a97a4, 6px 4px #8a97a4, 8px 4px #6d7884, 10px 4px #6d7884,
        -8px 6px #545e68, -6px 6px #6d7884, -4px 6px #6d7884, -2px 6px #6d7884, 0 6px #6d7884, 2px 6px #6d7884, 4px 6px #6d7884, 6px 6px #545e68, 8px 6px #545e68,
        /* Ice shards + sparkle */
        -8px 0 #bfe6f8, -10px 2px #9fd8f2, 8px 0 #bfe6f8, 10px 2px #9fd8f2,
        6px -12px #ffffff, -6px -9px #ffffff`
  },
  {
    classes: ["mine-icon"],
    note: "ORE MINE - Rock face with a timbered entrance and glinting ore",
    base: "#6b6e78",
    px: `
        /* Rock hill crown */
        -4px -14px #7a7d88, -2px -14px #8a8d98, 0 -14px #8a8d98, 2px -14px #7a7d88,
        -8px -12px #6b6e78, -6px -12px #8a8d98, -4px -12px #9aa0ac, -2px -12px #9aa0ac, 0 -12px #9aa0ac, 2px -12px #8a8d98, 4px -12px #8a8d98, 6px -12px #6b6e78,
        -12px -10px #5c5f68, -10px -10px #7a7d88, -8px -10px #8a8d98, -6px -10px #9aa0ac, -4px -10px #8a8d98, -2px -10px #8a8d98, 0 -10px #8a8d98, 2px -10px #9aa0ac, 4px -10px #8a8d98, 6px -10px #7a7d88, 8px -10px #7a7d88, 10px -10px #5c5f68,
        /* Face with ore glints */
        -14px -8px #52555e, -12px -8px #6b6e78, -10px -8px #ffd84a, -8px -8px #7a7d88, -6px -8px #7a7d88, -4px -8px #6b6e78, -2px -8px #6b6e78, 0 -8px #6b6e78, 2px -8px #7a7d88, 4px -8px #7a7d88, 6px -8px #ffd84a, 8px -8px #6b6e78, 10px -8px #6b6e78, 12px -8px #52555e,
        -14px -6px #52555e, -12px -6px #6b6e78, -10px -6px #6b6e78, -8px -6px #6b6e78, 8px -6px #7a7d88, 10px -6px #e8b62e, 12px -6px #52555e,
        -14px -4px #4a4c54, -12px -4px #5c5f68, -10px -4px #6b6e78, -8px -4px #6b6e78, 8px -4px #6b6e78, 10px -4px #6b6e78, 12px -4px #4a4c54,
        -14px -2px #4a4c54, -12px -2px #5c5f68, -10px -2px #5c5f68, -8px -2px #6b6e78, 8px -2px #5c5f68, 10px -2px #5c5f68, 12px -2px #4a4c54,
        -14px 0 #42444c, -12px 0 #52555e, -10px 0 #5c5f68, -8px 0 #5c5f68, 8px 0 #5c5f68, 10px 0 #52555e, 12px 0 #42444c,
        -14px 2px #42444c, -12px 2px #52555e, -10px 2px #52555e, -8px 2px #52555e, 8px 2px #52555e, 10px 2px #4a4c54, 12px 2px #42444c,
        /* Timber frame */
        -6px -6px #8a6438, -4px -6px #a07444, -2px -6px #a07444, 0 -6px #a07444, 2px -6px #a07444, 4px -6px #8a6438, 6px -6px #8a6438,
        -6px -4px #8a6438, 6px -4px #8a6438,
        -6px -2px #8a6438, 6px -2px #8a6438,
        -6px 0 #8a6438, 6px 0 #8a6438,
        -6px 2px #8a6438, 6px 2px #8a6438,
        /* Dark entrance */
        -4px -4px #14100c, -2px -4px #1a140e, 0 -4px #14100c, 2px -4px #1a140e, 4px -4px #14100c,
        -4px -2px #0e0a08, -2px -2px #14100c, 0 -2px #0e0a08, 2px -2px #14100c, 4px -2px #0e0a08,
        -4px 0 #0a0806, -2px 0 #0e0a08, 0 0 #0a0806, 2px 0 #0e0a08, 4px 0 #0a0806,
        -4px 2px #0a0806, -2px 2px #0a0806, 0 2px #0a0806, 2px 2px #0a0806, 4px 2px #0a0806,
        /* Rails running out of the mouth */
        -3px 4px #5c4326, 3px 4px #5c4326,
        -3px 6px #5c4326, 3px 6px #5c4326, -1px 5px #6d5230, 1px 5px #6d5230,
        /* Ground */
        -12px 4px #4a4c54, -10px 4px #52555e, -8px 4px #52555e, 6px 4px #52555e, 8px 4px #52555e, 10px 4px #4a4c54,
        -10px 6px #3e4046, -8px 6px #42444c, 8px 6px #42444c, 10px 6px #3e4046`
  },
  {
    classes: ["farm-icon"],
    note: "FARM - Tilled rows with sprouting crops and a wheat corner",
    base: "#6d4f30",
    px: `
        /* Field bed */
        -12px -8px #59402a, -10px -8px #6d4f30, -8px -8px #6d4f30, -6px -8px #6d4f30, -4px -8px #6d4f30, -2px -8px #6d4f30, 0 -8px #6d4f30, 2px -8px #6d4f30, 4px -8px #6d4f30, 6px -8px #6d4f30, 8px -8px #6d4f30, 10px -8px #6d4f30, 12px -8px #59402a,
        -12px -4px #59402a, -10px -4px #7a5a38, -8px -4px #7a5a38, -6px -4px #7a5a38, -4px -4px #7a5a38, -2px -4px #7a5a38, 0 -4px #7a5a38, 2px -4px #7a5a38, 4px -4px #7a5a38, 6px -4px #7a5a38, 8px -4px #7a5a38, 10px -4px #7a5a38, 12px -4px #59402a,
        -12px 0 #59402a, -10px 0 #6d4f30, -8px 0 #6d4f30, -6px 0 #6d4f30, -4px 0 #6d4f30, -2px 0 #6d4f30, 0 0 #6d4f30, 2px 0 #6d4f30, 4px 0 #6d4f30, 6px 0 #6d4f30, 8px 0 #6d4f30, 10px 0 #6d4f30, 12px 0 #59402a,
        -12px 4px #59402a, -10px 4px #7a5a38, -8px 4px #7a5a38, -6px 4px #7a5a38, -4px 4px #7a5a38, -2px 4px #7a5a38, 0 4px #7a5a38, 2px 4px #7a5a38, 4px 4px #7a5a38, 6px 4px #7a5a38, 8px 4px #7a5a38, 10px 4px #7a5a38, 12px 4px #59402a,
        -12px 8px #4a3422, -10px 8px #59402a, -8px 8px #59402a, -6px 8px #59402a, -4px 8px #59402a, -2px 8px #59402a, 0 8px #59402a, 2px 8px #59402a, 4px 8px #59402a, 6px 8px #59402a, 8px 8px #59402a, 10px 8px #59402a, 12px 8px #4a3422,
        /* Sprout rows */
        -10px -10px #4f8a3c, -6px -10px #5fa848, -2px -10px #4f8a3c, 2px -10px #5fa848, 6px -10px #4f8a3c, 10px -10px #5fa848,
        -10px -6px #5fa848, -6px -6px #4f8a3c, -2px -6px #5fa848, 2px -6px #4f8a3c, 6px -6px #5fa848, 10px -6px #4f8a3c,
        -10px -2px #4f8a3c, -6px -2px #5fa848, -2px -2px #4f8a3c, 2px -2px #5fa848, 6px -2px #4f8a3c, 10px -2px #5fa848,
        -10px 2px #5fa848, -6px 2px #4f8a3c, -2px 2px #5fa848, 2px 2px #4f8a3c, 6px 2px #5fa848, 10px 2px #4f8a3c,
        -10px 6px #4f8a3c, -6px 6px #5fa848, -2px 6px #4f8a3c, 2px 6px #5fa848, 6px 6px #4f8a3c, 10px 6px #5fa848,
        /* Ripe wheat corner */
        8px -12px #e8c04a, 10px -12px #f2d268, 12px -12px #e8c04a,
        10px -14px #f2d268, 12px -14px #e8c04a`
  },
  {
    classes: ["storage-icon"],
    note: "STOREHOUSE - Timber barn with cross-braced doors and a barrel",
    base: "#8a6438",
    px: `
        /* Roof ridge */
        -2px -14px #a25b31, 0 -14px #b4703c, 2px -14px #a25b31,
        -6px -12px #a25b31, -4px -12px #b4703c, -2px -12px #c07a44, 0 -12px #c07a44, 2px -12px #b4703c, 4px -12px #b4703c, 6px -12px #a25b31,
        -10px -10px #8a4a28, -8px -10px #a25b31, -6px -10px #b4703c, -4px -10px #c07a44, -2px -10px #c07a44, 0 -10px #c07a44, 2px -10px #b4703c, 4px -10px #b4703c, 6px -10px #a25b31, 8px -10px #a25b31, 10px -10px #8a4a28,
        -12px -8px #7e4423, -10px -8px #8a4a28, 10px -8px #8a4a28, 12px -8px #7e4423,
        /* Walls */
        -10px -6px #8a6438, -8px -6px #9a7040, -6px -6px #9a7040, -4px -6px #9a7040, -2px -6px #9a7040, 0 -6px #9a7040, 2px -6px #9a7040, 4px -6px #9a7040, 6px -6px #9a7040, 8px -6px #9a7040, 10px -6px #8a6438,
        -10px -4px #8a6438, -8px -4px #9a7040, -6px -4px #9a7040, 6px -4px #9a7040, 8px -4px #9a7040, 10px -4px #8a6438,
        -10px -2px #7a5830, -8px -2px #8a6438, -6px -2px #8a6438, 6px -2px #8a6438, 8px -2px #8a6438, 10px -2px #7a5830,
        -10px 0 #7a5830, -8px 0 #8a6438, -6px 0 #8a6438, 6px 0 #8a6438, 8px 0 #8a6438, 10px 0 #7a5830,
        -10px 2px #6d4c28, -8px 2px #7a5830, -6px 2px #7a5830, 6px 2px #7a5830, 8px 2px #7a5830, 10px 2px #6d4c28,
        -10px 4px #6d4c28, -8px 4px #6d4c28, -6px 4px #6d4c28, 6px 4px #6d4c28, 8px 4px #6d4c28, 10px 4px #6d4c28,
        /* Cross-braced barn door */
        -4px -4px #5c4326, -2px -4px #4a3a24, 0 -4px #4a3a24, 2px -4px #4a3a24, 4px -4px #5c4326,
        -4px -2px #4a3a24, -2px -2px #6d5230, 0 -2px #4a3a24, 2px -2px #6d5230, 4px -2px #4a3a24,
        -4px 0 #4a3a24, -2px 0 #4a3a24, 0 0 #6d5230, 2px 0 #4a3a24, 4px 0 #4a3a24,
        -4px 2px #4a3a24, -2px 2px #6d5230, 0 2px #4a3a24, 2px 2px #6d5230, 4px 2px #4a3a24,
        -4px 4px #5c4326, -2px 4px #4a3a24, 0 4px #4a3a24, 2px 4px #4a3a24, 4px 4px #5c4326,
        /* Barrel by the door */
        12px -2px #7a5230, 14px -2px #8f6238,
        12px 0 #8f6238, 14px 0 #7a5230,
        12px 2px #7a5230, 14px 2px #8f6238,
        12px 4px #5e3f24, 14px 4px #5e3f24,
        /* Grain sacks on the left */
        -14px 2px #c9ae86, -12px 2px #d8bd94,
        -14px 4px #c9ae86, -12px 4px #b0966e,
        /* Ground shadow */
        -8px 6px #2e3034, -6px 6px #2e3034, -4px 6px #2e3034, -2px 6px #2e3034, 0 6px #2e3034, 2px 6px #2e3034, 4px 6px #2e3034, 6px 6px #2e3034, 8px 6px #2e3034`
  },
  {
    classes: ["mortar-icon"],
    note: "MORTAR - Wide stumpy barrel on rotating stone base",
    base: "#505050",
    px: `
        /* Wide barrel opening with dark inside */
        -6px -14px #303030, -4px -14px #404040, -2px -14px #505050, 0 -14px #606060, 2px -14px #505050, 4px -14px #404040, 6px -14px #303030,
        -8px -12px #404040, -6px -12px #505050, -4px -12px #1A1A1A, -2px -12px #0A0A0A, 0 -12px #0A0A0A, 2px -12px #0A0A0A, 4px -12px #1A1A1A, 6px -12px #505050, 8px -12px #404040,
        /* Barrel body */
        -10px -10px #505050, -8px -10px #606060, -6px -10px #696969, -4px -10px #808080, -2px -10px #909090, 0 -10px #A0A0A0, 2px -10px #909090, 4px -10px #808080, 6px -10px #696969, 8px -10px #606060, 10px -10px #505050,
        -10px -8px #404040, -8px -8px #505050, -6px -8px #606060, -4px -8px #696969, -2px -8px #808080, 0 -8px #909090, 2px -8px #808080, 4px -8px #696969, 6px -8px #606060, 8px -8px #505050, 10px -8px #404040,
        /* Barrel base */
        -8px -6px #303030, -6px -6px #404040, -4px -6px #505050, -2px -6px #606060, 0 -6px #696969, 2px -6px #606060, 4px -6px #505050, 6px -6px #404040, 8px -6px #303030,
        /* Stone rotating base */
        -12px -4px #4A4A4A, -10px -4px #5A5A5A, -8px -4px #6A6A6A, -6px -4px #7A7A7A, -4px -4px #8A8A8A, -2px -4px #7A7A7A, 0 -4px #8A8A8A, 2px -4px #7A7A7A, 4px -4px #8A8A8A, 6px -4px #7A7A7A, 8px -4px #6A6A6A, 10px -4px #5A5A5A, 12px -4px #4A4A4A,
        -14px -2px #393939, -12px -2px #494949, -10px -2px #595959, -8px -2px #696969, -6px -2px #797979, -4px -2px #696969, -2px -2px #797979, 0 -2px #696969, 2px -2px #797979, 4px -2px #696969, 6px -2px #797979, 8px -2px #696969, 10px -2px #595959, 12px -2px #494949, 14px -2px #393939,
        /* Ground base */
        -14px 0 #2A2A2A, -12px 0 #393939, -10px 0 #494949, -8px 0 #595959, -6px 0 #494949, -4px 0 #595959, -2px 0 #494949, 0 0 #595959, 2px 0 #494949, 4px 0 #595959, 6px 0 #494949, 8px 0 #595959, 10px 0 #494949, 12px 0 #393939, 14px 0 #2A2A2A,
        -12px 2px #1A1A1A, -10px 2px #2A2A2A, -8px 2px #393939, -6px 2px #2A2A2A, -4px 2px #393939, -2px 2px #2A2A2A, 0 2px #393939, 2px 2px #2A2A2A, 4px 2px #393939, 6px 2px #2A2A2A, 8px 2px #393939, 10px 2px #2A2A2A, 12px 2px #1A1A1A`
  },
  {
    classes: ["ballista-icon"],
    note: "BALLISTA - Detailed mounted crossbow with arrow, bow arms, string",
    base: "#8B4513",
    px: `
        /* Arrow/bolt tip */
        0 -20px #B0C4DE, 0 -18px #C0C0C0,
        -2px -16px #A9A9A9, 0 -16px #C0C0C0, 2px -16px #A9A9A9,
        /* Arrow shaft */
        0 -14px #8B4513, 0 -12px #A0522D, 0 -10px #8B4513, 0 -8px #A0522D, 0 -6px #8B4513,
        /* Fletching */
        -2px -6px #DC143C, 2px -6px #DC143C,
        -2px -4px #B22222, 2px -4px #B22222,
        /* Bow arm - left curving */
        -4px -10px #654321, -6px -10px #8B4513,
        -8px -8px #654321, -10px -8px #8B4513, -12px -8px #654321,
        -14px -6px #5C3317, -16px -6px #654321, -18px -4px #5C3317,
        -18px -2px #654321, -16px 0 #8B4513,
        /* Bow arm - right curving */
        4px -10px #654321, 6px -10px #8B4513,
        8px -8px #654321, 10px -8px #8B4513, 12px -8px #654321,
        14px -6px #5C3317, 16px -6px #654321, 18px -4px #5C3317,
        18px -2px #654321, 16px 0 #8B4513,
        /* Bowstring - taut */
        -16px -2px #808080, -14px -2px #909090, -12px -4px #909090, -10px -4px #A0A0A0, -8px -4px #909090, -6px -4px #909090, -4px -4px #808080,
        4px -4px #808080, 6px -4px #909090, 8px -4px #909090, 10px -4px #A0A0A0, 12px -4px #909090, 14px -2px #909090, 16px -2px #808080,
        /* Main crossbow body */
        -4px -2px #654321, -2px -2px #8B4513, 0 -2px #A0522D, 2px -2px #8B4513, 4px -2px #654321,
        -6px 0 #5C3317, -4px 0 #654321, -2px 0 #8B4513, 0 0 #A0522D, 2px 0 #8B4513, 4px 0 #654321, 6px 0 #5C3317,
        /* Tripod stand */
        -8px 2px #5C3317, -4px 2px #654321, 0 2px #8B4513, 4px 2px #654321, 8px 2px #5C3317,
        -12px 4px #3A2A1A, -10px 4px #5C3317, -6px 4px #654321, 0 4px #8B4513, 6px 4px #654321, 10px 4px #5C3317, 12px 4px #3A2A1A,
        -14px 6px #2A1A0A, -12px 6px #3A2A1A, 0 6px #5C3317, 12px 6px #3A2A1A, 14px 6px #2A1A0A`
  },
  {
    classes: ["xbow-icon"],
    note: "XBOW - Rapid fire turret with X-shaped arms and ammo magazine",
    base: "#8B008B",
    px: `
        /* Barrel pointing up */
        0 -18px #505050, 0 -16px #606060, 0 -14px #505050,
        -2px -12px #404040, 0 -12px #505050, 2px -12px #404040,
        /* X-shaped bow arms - left upper */
        -4px -14px #9B30FF, -6px -12px #8B008B, -8px -10px #9B30FF, -10px -8px #8B008B, -12px -6px #9B30FF,
        /* X-shaped bow arms - right upper */
        4px -14px #9B30FF, 6px -12px #8B008B, 8px -10px #9B30FF, 10px -8px #8B008B, 12px -6px #9B30FF,
        /* X-shaped bow arms - left lower */
        -12px -4px #8B008B, -10px -2px #9B30FF, -8px 0 #8B008B,
        /* X-shaped bow arms - right lower */
        12px -4px #8B008B, 10px -2px #9B30FF, 8px 0 #8B008B,
        /* Center turret body */
        -6px -8px #404040, -4px -8px #505050, -2px -8px #606060, 0 -8px #8B008B, 2px -8px #606060, 4px -8px #505050, 6px -8px #404040,
        -6px -6px #303030, -4px -6px #8B008B, -2px -6px #9B30FF, 0 -6px #BA55D3, 2px -6px #9B30FF, 4px -6px #8B008B, 6px -6px #303030,
        -6px -4px #404040, -4px -4px #505050, -2px -4px #8B008B, 0 -4px #9B30FF, 2px -4px #8B008B, 4px -4px #505050, 6px -4px #404040,
        /* Ammo magazine */
        -4px -2px #FFD700, -2px -2px #FFA500, 0 -2px #FFD700, 2px -2px #FFA500, 4px -2px #FFD700,
        /* Rotating base */
        -8px 0 #404040, -6px 0 #505050, -4px 0 #606060, -2px 0 #505050, 0 0 #606060, 2px 0 #505050, 4px 0 #606060, 6px 0 #505050, 8px 0 #404040,
        -10px 2px #303030, -8px 2px #404040, -6px 2px #505050, -4px 2px #404040, -2px 2px #505050, 0 2px #404040, 2px 2px #505050, 4px 2px #404040, 6px 2px #505050, 8px 2px #404040, 10px 2px #303030,
        -8px 4px #202020, -6px 4px #303030, -4px 4px #404040, -2px 4px #303030, 0 4px #404040, 2px 4px #303030, 4px 4px #404040, 6px 4px #303030, 8px 4px #202020`
  },
  {
    classes: ["tesla-icon"],
    note: "TESLA COIL - Electric tower with glowing orb and lightning",
    base: "#00BFFF",
    px: `
        /* Lightning sparks branching out */
        -8px -20px #FFFF00, -6px -18px #FFF, -4px -16px #FFFF00,
        8px -20px #FFFF00, 6px -18px #FFF, 4px -16px #FFFF00,
        0 -22px #FFF, 0 -20px #FFFF00, 0 -18px #FFF,
        /* Glowing electric orb */
        -4px -14px #4169E1, -2px -14px #00BFFF, 0 -14px #87CEEB, 2px -14px #00BFFF, 4px -14px #4169E1,
        -6px -12px #0000CD, -4px -12px #4169E1, -2px -12px #00BFFF, 0 -12px #FFF, 2px -12px #00BFFF, 4px -12px #4169E1, 6px -12px #0000CD,
        -6px -10px #0000CD, -4px -10px #00BFFF, -2px -10px #87CEEB, 0 -10px #FFF, 2px -10px #87CEEB, 4px -10px #00BFFF, 6px -10px #0000CD,
        -4px -8px #4169E1, -2px -8px #00BFFF, 0 -8px #87CEEB, 2px -8px #00BFFF, 4px -8px #4169E1,
        /* Coil rings */
        -4px -6px #B87333, -2px -6px #CD7F32, 0 -6px #D4AF37, 2px -6px #CD7F32, 4px -6px #B87333,
        -4px -4px #8B6914, -2px -4px #B87333, 0 -4px #CD7F32, 2px -4px #B87333, 4px -4px #8B6914,
        /* Metal pole */
        -2px -2px #505050, 0 -2px #696969, 2px -2px #505050,
        -2px 0 #404040, 0 0 #505050, 2px 0 #404040,
        /* Metal base platform */
        -8px 2px #404040, -6px 2px #505050, -4px 2px #606060, -2px 2px #505050, 0 2px #606060, 2px 2px #505050, 4px 2px #606060, 6px 2px #505050, 8px 2px #404040,
        -10px 4px #303030, -8px 4px #404040, -6px 4px #505050, -4px 4px #404040, -2px 4px #505050, 0 4px #404040, 2px 4px #505050, 4px 4px #404040, 6px 4px #505050, 8px 4px #404040, 10px 4px #303030,
        -8px 6px #202020, -6px 6px #303030, -4px 6px #404040, -2px 6px #303030, 0 6px #404040, 2px 6px #303030, 4px 6px #404040, 6px 6px #303030, 8px 6px #202020`
  },
  {
    classes: ["prism-icon"],
    note: "PRISM TOWER - Tall faceted glowing crystal on stone pedestal",
    base: "#FF69B4",
    px: `
        /* Crystal tip - bright white glow */
        0 -20px #FFF, 0 -18px #FFF,
        -2px -16px #FFB6C1, 0 -16px #FFF, 2px -16px #FFB6C1,
        /* Upper crystal facets */
        -4px -14px #FF69B4, -2px -14px #FFB6C1, 0 -14px #FFF, 2px -14px #FFB6C1, 4px -14px #FF69B4,
        -6px -12px #FF1493, -4px -12px #FF69B4, -2px -12px #FFB6C1, 0 -12px #FFF, 2px -12px #FFB6C1, 4px -12px #FF69B4, 6px -12px #FF1493,
        /* Middle crystal body */
        -6px -10px #C71585, -4px -10px #FF1493, -2px -10px #FF69B4, 0 -10px #FFB6C1, 2px -10px #FF69B4, 4px -10px #FF1493, 6px -10px #C71585,
        -6px -8px #8B008B, -4px -8px #C71585, -2px -8px #FF1493, 0 -8px #FF69B4, 2px -8px #FF1493, 4px -8px #C71585, 6px -8px #8B008B,
        -6px -6px #800080, -4px -6px #8B008B, -2px -6px #C71585, 0 -6px #FF1493, 2px -6px #C71585, 4px -6px #8B008B, 6px -6px #800080,
        /* Crystal base */
        -4px -4px #4B0082, -2px -4px #8B008B, 0 -4px #C71585, 2px -4px #8B008B, 4px -4px #4B0082,
        /* Stone pedestal */
        -8px -2px #606060, -6px -2px #707070, -4px -2px #808080, -2px -2px #707070, 0 -2px #808080, 2px -2px #707070, 4px -2px #808080, 6px -2px #707070, 8px -2px #606060,
        -10px 0 #505050, -8px 0 #606060, -6px 0 #707070, -4px 0 #606060, -2px 0 #707070, 0 0 #606060, 2px 0 #707070, 4px 0 #606060, 6px 0 #707070, 8px 0 #606060, 10px 0 #505050,
        -10px 2px #404040, -8px 2px #505050, -6px 2px #606060, -4px 2px #505050, -2px 2px #606060, 0 2px #505050, 2px 2px #606060, 4px 2px #505050, 6px 2px #606060, 8px 2px #505050, 10px 2px #404040,
        -8px 4px #303030, -6px 4px #404040, -4px 4px #505050, -2px 4px #404040, 0 4px #505050, 2px 4px #404040, 4px 4px #505050, 6px 4px #404040, 8px 4px #303030`
  },
  {
    classes: ["dragons_breath-icon"],
    note: "DRAGON'S BREATH - Fearsome dragon head statue breathing fire",
    base: "#CC0000",
    px: `
        /* Flames shooting out */
        -12px -16px #FFFF00, -10px -14px #FF8C00, -8px -12px #FFFF00,
        -14px -14px #FF4500, -12px -12px #FF8C00, -10px -10px #FFFF00,
        -16px -12px #FF4500, -14px -10px #FF6347, -12px -8px #FF8C00, -10px -6px #FFFF00,
        /* Dragon head - snout */
        -8px -14px #8B0000, -6px -14px #CC0000, -4px -14px #8B0000,
        -6px -12px #CC0000, -4px -12px #DC143C, -2px -12px #CC0000,
        /* Dragon head - main */
        -4px -10px #8B0000, -2px -10px #CC0000, 0 -10px #DC143C, 2px -10px #CC0000, 4px -10px #8B0000,
        -6px -8px #660000, -4px -8px #8B0000, -2px -8px #CC0000, 0 -8px #DC143C, 2px -8px #CC0000, 4px -8px #8B0000, 6px -8px #660000,
        /* Dragon eyes */
        0 -8px #FFFF00, 2px -8px #FF8C00,
        /* Dragon horns */
        -8px -8px #5C3317, 8px -8px #5C3317,
        -10px -6px #654321, 10px -6px #654321,
        /* Dragon neck/body */
        -6px -6px #660000, -4px -6px #8B0000, -2px -6px #CC0000, 0 -6px #CC0000, 2px -6px #CC0000, 4px -6px #8B0000, 6px -6px #660000,
        -6px -4px #4A0000, -4px -4px #660000, -2px -4px #8B0000, 0 -4px #8B0000, 2px -4px #8B0000, 4px -4px #660000, 6px -4px #4A0000,
        /* Stone base */
        -10px -2px #505050, -8px -2px #606060, -6px -2px #707070, -4px -2px #606060, -2px -2px #707070, 0 -2px #606060, 2px -2px #707070, 4px -2px #606060, 6px -2px #707070, 8px -2px #606060, 10px -2px #505050,
        -12px 0 #404040, -10px 0 #505050, -8px 0 #606060, -6px 0 #505050, -4px 0 #606060, -2px 0 #505050, 0 0 #606060, 2px 0 #505050, 4px 0 #606060, 6px 0 #505050, 8px 0 #606060, 10px 0 #505050, 12px 0 #404040,
        -10px 2px #303030, -8px 2px #404040, -6px 2px #505050, -4px 2px #404040, -2px 2px #505050, 0 2px #404040, 2px 2px #505050, 4px 2px #404040, 6px 2px #505050, 8px 2px #404040, 10px 2px #303030`
  },
  {
    classes: ["barracks-icon"],
    note: "BARRACKS - Military training building with red roof, door, and crossed swords",
    base: "#DC143C",
    px: `
        /* Sword crossed on roof (left) */
        -8px -18px #C0C0C0, -6px -16px #A9A9A9, -4px -14px #C0C0C0,
        /* Sword crossed on roof (right) */
        8px -18px #C0C0C0, 6px -16px #A9A9A9, 4px -14px #C0C0C0,
        /* Red peaked roof */
        -2px -16px #8B0000, 0 -16px #DC143C, 2px -16px #8B0000,
        -6px -14px #8B0000, -4px -14px #B22222, -2px -14px #DC143C, 0 -14px #FF4500, 2px -14px #DC143C, 4px -14px #B22222, 6px -14px #8B0000,
        -10px -12px #660000, -8px -12px #8B0000, -6px -12px #B22222, -4px -12px #DC143C, -2px -12px #DC143C, 0 -12px #DC143C, 2px -12px #DC143C, 4px -12px #DC143C, 6px -12px #B22222, 8px -12px #8B0000, 10px -12px #660000,
        /* Stone building walls */
        -10px -10px #8B4513, -8px -10px #A0522D, -6px -10px #D2691E, -4px -10px #CD853F, -2px -10px #D2691E, 0 -10px #CD853F, 2px -10px #D2691E, 4px -10px #CD853F, 6px -10px #D2691E, 8px -10px #A0522D, 10px -10px #8B4513,
        -10px -8px #654321, -8px -8px #8B4513, -6px -8px #A0522D, -4px -8px #8B4513, -2px -8px #A0522D, 0 -8px #8B4513, 2px -8px #A0522D, 4px -8px #8B4513, 6px -8px #A0522D, 8px -8px #8B4513, 10px -8px #654321,
        /* Windows */
        -6px -8px #4169E1, -4px -8px #87CEEB, 4px -8px #4169E1, 6px -8px #87CEEB,
        /* More walls */
        -10px -6px #5C3317, -8px -6px #654321, -6px -6px #8B4513, -4px -6px #654321, -2px -6px #8B4513, 0 -6px #654321, 2px -6px #8B4513, 4px -6px #654321, 6px -6px #8B4513, 8px -6px #654321, 10px -6px #5C3317,
        /* Door (center) */
        -10px -4px #5C3317, -8px -4px #654321, -6px -4px #8B4513, -4px -4px #3E2723, -2px -4px #2A1A0A, 0 -4px #2A1A0A, 2px -4px #2A1A0A, 4px -4px #3E2723, 6px -4px #8B4513, 8px -4px #654321, 10px -4px #5C3317,
        -10px -2px #3E2723, -8px -2px #5C3317, -6px -2px #654321, -4px -2px #3E2723, -2px -2px #1A0A00, 0 -2px #1A0A00, 2px -2px #1A0A00, 4px -2px #3E2723, 6px -2px #654321, 8px -2px #5C3317, 10px -2px #3E2723,
        /* Foundation */
        -12px 0 #404040, -10px 0 #505050, -8px 0 #606060, -6px 0 #505050, -4px 0 #606060, -2px 0 #505050, 0 0 #606060, 2px 0 #505050, 4px 0 #606060, 6px 0 #505050, 8px 0 #606060, 10px 0 #505050, 12px 0 #404040,
        -10px 2px #303030, -8px 2px #404040, -6px 2px #505050, -4px 2px #404040, -2px 2px #505050, 0 2px #404040, 2px 2px #505050, 4px 2px #404040, 6px 2px #505050, 8px 2px #404040, 10px 2px #303030`
  },
  {
    classes: ["lab-icon"],
    note: "LAB - Alchemist's workshop with smokestack, bubbling flask, and purple glow",
    base: "#6644AA",
    px: `
        /* Smokestack */
        8px -18px #555, 8px -16px #666, 8px -14px #666, 8px -12px #555,
        10px -18px #444, 10px -16px #555, 10px -14px #555, 10px -12px #444,
        /* Smoke puffs */
        8px -20px rgba(120,80,180,0.6), 10px -22px rgba(120,80,180,0.4), 6px -24px rgba(120,80,180,0.2),
        /* Slate roof */
        -10px -10px #3a3448, -8px -10px #3a3448, -6px -10px #4a4458, -4px -10px #4a4458, -2px -10px #4a4458, 0 -10px #4a4458, 2px -10px #4a4458, 4px -10px #3a3448, 6px -10px #3a3448,
        -8px -12px #2a2438, -6px -12px #3a3448, -4px -12px #3a3448, -2px -12px #3a3448, 0 -12px #3a3448, 2px -12px #3a3448, 4px -12px #3a3448, 6px -12px #2a2438,
        /* Stone walls */
        -10px -8px #5a5a6a, -8px -8px #6a6a7a, -6px -8px #5a5a6a, -4px -8px #6a6a7a, -2px -8px #5a5a6a, 0 -8px #6a6a7a, 2px -8px #5a5a6a, 4px -8px #6a6a7a, 6px -8px #5a5a6a, 8px -8px #6a6a7a, 10px -8px #5a5a6a,
        -10px -6px #4a4a5a, -8px -6px #5a5a6a, -6px -6px #4a4a5a, -4px -6px #5a5a6a, -2px -6px #4a4a5a, 0 -6px #5a5a6a, 2px -6px #4a4a5a, 4px -6px #5a5a6a, 6px -6px #4a4a5a, 8px -6px #5a5a6a, 10px -6px #4a4a5a,
        /* Glowing windows */
        -6px -6px #44CC88, -4px -6px #44CC88, 4px -6px #44CC88, 6px -6px #44CC88,
        /* More walls with door */
        -10px -4px #4a4a5a, -8px -4px #5a5a6a, -6px -4px #4a4a5a, -4px -4px #0a0a15, -2px -4px #0a0a15, 0 -4px #0a0a15, 2px -4px #0a0a15, 4px -4px #4a4a5a, 6px -4px #5a5a6a, 8px -4px #5a5a6a, 10px -4px #4a4a5a,
        -10px -2px #3a3a4a, -8px -2px #4a4a5a, -6px -2px #3a3a4a, -4px -2px #0a0a15, -2px -2px #33AA66, 0 -2px #0a0a15, 2px -2px #0a0a15, 4px -2px #3a3a4a, 6px -2px #4a4a5a, 8px -2px #4a4a5a, 10px -2px #3a3a4a,
        /* Flask inside door glow */
        -2px -4px #33AA66,
        /* Stone foundation */
        -12px 0 #404050, -10px 0 #505060, -8px 0 #606070, -6px 0 #505060, -4px 0 #606070, -2px 0 #505060, 0 0 #606070, 2px 0 #505060, 4px 0 #606070, 6px 0 #505060, 8px 0 #606070, 10px 0 #505060, 12px 0 #404050,
        /* Foundation base */
        -10px 2px #303040, -8px 2px #404050, -6px 2px #505060, -4px 2px #404050, -2px 2px #505060, 0 2px #404050, 2px 2px #505060, 4px 2px #404050, 6px 2px #505060, 8px 2px #404050, 10px 2px #303040,
        /* Acid stain on ground */
        -6px 4px #334433, -4px 4px #445544, 4px 4px #334433`
  },
  {
    classes: ["army_camp-icon"],
    note: "ARMY CAMP - Military tent with campfire and weapons rack",
    base: "#D2691E",
    px: `
        /* Tent pole flag */
        0 -20px #DC143C, 2px -20px #FF0000, 4px -20px #DC143C,
        0 -18px #DC143C, 2px -18px #B22222,
        0 -16px #654321,
        /* Tent top */
        -2px -14px #D2691E, 0 -14px #A0522D, 2px -14px #D2691E,
        -4px -12px #CD853F, -2px -12px #D2691E, 0 -12px #A0522D, 2px -12px #D2691E, 4px -12px #CD853F,
        -6px -10px #A0522D, -4px -10px #D2691E, -2px -10px #CD853F, 0 -10px #D2691E, 2px -10px #CD853F, 4px -10px #D2691E, 6px -10px #A0522D,
        -8px -8px #8B4513, -6px -8px #A0522D, -4px -8px #D2691E, -2px -8px #CD853F, 0 -8px #D2691E, 2px -8px #CD853F, 4px -8px #D2691E, 6px -8px #A0522D, 8px -8px #8B4513,
        /* Tent body */
        -10px -6px #654321, -8px -6px #8B4513, -6px -6px #A0522D, -4px -6px #8B4513, -2px -6px #A0522D, 0 -6px #8B4513, 2px -6px #A0522D, 4px -6px #8B4513, 6px -6px #A0522D, 8px -6px #8B4513, 10px -6px #654321,
        /* Tent entrance (dark) */
        -10px -4px #5C3317, -8px -4px #654321, -6px -4px #8B4513, -4px -4px #2A1A0A, -2px -4px #1A0A00, 0 -4px #1A0A00, 2px -4px #1A0A00, 4px -4px #2A1A0A, 6px -4px #8B4513, 8px -4px #654321, 10px -4px #5C3317,
        /* Campfire in front */
        -2px -2px #FF4500, 0 -2px #FFFF00, 2px -2px #FF4500,
        -4px 0 #FF8C00, -2px 0 #FFFF00, 0 0 #FFF, 2px 0 #FFFF00, 4px 0 #FF8C00,
        /* Logs */
        -6px 2px #5C3317, -4px 2px #654321, -2px 2px #8B0000, 0 2px #DC143C, 2px 2px #8B0000, 4px 2px #654321, 6px 2px #5C3317,
        -4px 4px #3E2723, -2px 4px #5C3317, 0 4px #654321, 2px 4px #5C3317, 4px 4px #3E2723`
  },
  {
    classes: ["wall-icon"],
    note: "WALL - Strong stone fortification block",
    base: "#808080",
    px: `
        /* Top battlements */
        -10px -14px #808080, -8px -14px #909090, -6px -14px #808080,
        2px -14px #808080, 4px -14px #909090, 6px -14px #808080,
        -10px -12px #707070, -8px -12px #808080, -6px -12px #707070,
        2px -12px #707070, 4px -12px #808080, 6px -12px #707070,
        /* Wall face - upper */
        -10px -10px #606060, -8px -10px #707070, -6px -10px #808080, -4px -10px #707070, -2px -10px #808080, 0 -10px #707070, 2px -10px #808080, 4px -10px #707070, 6px -10px #808080, 8px -10px #707070, 10px -10px #606060,
        -10px -8px #505050, -8px -8px #606060, -6px -8px #707070, -4px -8px #808080, -2px -8px #707070, 0 -8px #808080, 2px -8px #707070, 4px -8px #808080, 6px -8px #707070, 8px -8px #606060, 10px -8px #505050,
        /* Stone blocks pattern */
        -10px -6px #606060, -8px -6px #707070, -6px -6px #505050, -4px -6px #707070, -2px -6px #606060, 0 -6px #707070, 2px -6px #505050, 4px -6px #707070, 6px -6px #606060, 8px -6px #707070, 10px -6px #606060,
        -10px -4px #505050, -8px -4px #606060, -6px -4px #707070, -4px -4px #606060, -2px -4px #707070, 0 -4px #606060, 2px -4px #707070, 4px -4px #606060, 6px -4px #707070, 8px -4px #606060, 10px -4px #505050,
        /* Lower wall */
        -10px -2px #404040, -8px -2px #505050, -6px -2px #606060, -4px -2px #505050, -2px -2px #606060, 0 -2px #505050, 2px -2px #606060, 4px -2px #505050, 6px -2px #606060, 8px -2px #505050, 10px -2px #404040,
        -10px 0 #303030, -8px 0 #404040, -6px 0 #505050, -4px 0 #404040, -2px 0 #505050, 0 0 #404040, 2px 0 #505050, 4px 0 #404040, 6px 0 #505050, 8px 0 #404040, 10px 0 #303030,
        /* Foundation */
        -12px 2px #202020, -10px 2px #303030, -8px 2px #404040, -6px 2px #303030, -4px 2px #404040, -2px 2px #303030, 0 2px #404040, 2px 2px #303030, 4px 2px #404040, 6px 2px #303030, 8px 2px #404040, 10px 2px #303030, 12px 2px #202020,
        -10px 4px #101010, -8px 4px #202020, -6px 4px #303030, -4px 4px #202020, -2px 4px #303030, 0 4px #202020, 2px 4px #303030, 4px 4px #202020, 6px 4px #303030, 8px 4px #202020, 10px 4px #101010`
  },
  {
    classes: ["tree-icon"],
    note: "Tree and rock obstacles - keep simpler",
    base: "#228B22",
    px: `
        0 -14px #006400, 0 -12px #228B22,
        -2px -10px #006400, 0 -10px #32CD32, 2px -10px #006400,
        -4px -8px #228B22, -2px -8px #32CD32, 0 -8px #90EE90, 2px -8px #32CD32, 4px -8px #228B22,
        -4px -6px #006400, -2px -6px #228B22, 0 -6px #32CD32, 2px -6px #228B22, 4px -6px #006400,
        -2px -4px #006400, 0 -4px #228B22, 2px -4px #006400,
        0 -2px #8B4513, 0 0 #654321, 0 2px #5C3317`
  },
  {
    classes: ["rock-icon","bush-icon"],
    note: "",
    base: "#808080",
    px: `
        -2px -8px #909090, 0 -8px #A0A0A0, 2px -8px #909090,
        -4px -6px #707070, -2px -6px #808080, 0 -6px #909090, 2px -6px #808080, 4px -6px #707070,
        -6px -4px #606060, -4px -4px #707070, -2px -4px #808080, 0 -4px #909090, 2px -4px #808080, 4px -4px #707070, 6px -4px #606060,
        -6px -2px #505050, -4px -2px #606060, -2px -2px #707070, 0 -2px #808080, 2px -2px #707070, 4px -2px #606060, 6px -2px #505050,
        -4px 0 #404040, -2px 0 #505050, 0 0 #606060, 2px 0 #505050, 4px 0 #404040`
  },
  {
    classes: ["spike_launcher-icon"],
    note: "SPIKE LAUNCHER - Medieval trebuchet with spike bag ammunition",
    base: "#8B4513",
    px: `
        /* A-Frame support structure */
        -8px 6px #5D4037, -6px 4px #6D5047, -4px 2px #5D4037, -2px 0 #8B4513,
        8px 6px #5D4037, 6px 4px #6D5047, 4px 2px #5D4037, 2px 0 #8B4513,
        /* Cross beam at top */
        -4px -2px #795548, -2px -2px #8D6E63, 0 -2px #A1887F, 2px -2px #8D6E63, 4px -2px #795548,
        /* Pivot hub */
        0 -4px #616161, -2px -4px #424242, 2px -4px #424242,
        /* Throwing arm (at rest angle) */
        -2px -6px #795548, 0 -6px #8D6E63, 2px -6px #795548,
        -4px -8px #6D5047, -2px -8px #795548, 0 -8px #8D6E63, 2px -8px #795548,
        -6px -10px #5D4037, -4px -10px #6D5047, -2px -10px #795548,
        -8px -12px #5D4037, -6px -12px #6D5047, -4px -12px #795548,
        /* Arm tip with sling */
        -10px -14px #B8A07A, -8px -14px #A08060,
        /* Spike bag in sling */
        -12px -12px #6B5B45, -10px -12px #7A6B55, -12px -10px #5A4A35,
        /* Spikes poking from bag */
        -14px -14px #888888, -10px -16px #888888, -14px -10px #888888,
        /* Counterweight */
        4px -8px #757575, 6px -8px #616161, 8px -8px #757575,
        4px -6px #5A5A5A, 6px -6px #4A4A4A, 8px -6px #5A5A5A,
        /* Rope winch */
        10px 0 #5D4037, 12px 0 #6D5047,
        10px 2px #B8A07A, 12px 2px #A08060,
        /* Spike bag pile */
        -8px 6px #6B5B45, -6px 8px #7A6B55, -4px 6px #5A4A35,
        -10px 8px #666666, -4px 8px #666666, -6px 4px #666666,
        /* Stone base platform */
        -12px 8px #5A5A5A, -10px 8px #6A6A6A, -8px 8px #7A7A7A, -6px 8px #6A6A6A, -4px 8px #7A7A7A, -2px 8px #6A6A6A, 0 8px #7A7A7A, 2px 8px #6A6A6A, 4px 8px #7A7A7A, 6px 8px #6A6A6A, 8px 8px #7A7A7A, 10px 8px #6A6A6A, 12px 8px #5A5A5A,
        -10px 10px #4A4A4A, -8px 10px #5A5A5A, -6px 10px #4A4A4A, -4px 10px #5A5A5A, -2px 10px #4A4A4A, 0 10px #5A5A5A, 2px 10px #4A4A4A, 4px 10px #5A5A5A, 6px 10px #4A4A4A, 8px 10px #5A5A5A, 10px 10px #4A4A4A`
  },
]
