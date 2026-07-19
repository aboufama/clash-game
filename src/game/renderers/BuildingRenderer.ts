
import Phaser from 'phaser';
import { windLoopAtScreen, windSwayLoopAtScreen } from '../systems/Wind';
import { IsoUtils, TILE_HEIGHT } from '../utils/IsoUtils';
import { BUILDING_DEFINITIONS } from '../config/GameDefinitions';
// Cannon: design B ("Bulldog Bombard") won the clean-room tournament and is
// the SHIPPED canonical cannon — called directly, no registry indirection.
import { drawCannonB } from './redesign/CannonB';
import { drawFactionBarracks } from './FactionBarracksRenderer';

/**
 * drawTownHall silhouette geometry — the ONE source for both the roof paint
 * below and the banner-pole socket exported to the runtime (MainScene.
 * updateHallBanner and the world-map postcard mini flags plant the village
 * banner here). Story walls + hipped-roof rise measured from the footprint
 * centre; the gold apex ball is painted APEX_BALL_LIFT above the peak.
 */
const TOWN_HALL_STORY_H = 24;      // stone ground story wall height
const TOWN_HALL_ROOF_H = 30;       // hipped "great roof" rise above the story
const TOWN_HALL_APEX_BALL_LIFT = 1; // gold apex-ball centre above the peak

/**
 * World-px lift from the town hall's footprint centre UP to the gold
 * apex-ball centre — the banner-pole socket. Per hall level: the hall ships
 * ONE silhouette today (maxLevel 1), so every level resolves to the same
 * apex; a future level that changes the story/roof geometry in drawTownHall
 * must branch here with its own numbers so the banner keeps tracking the
 * peak through upgrades.
 */
export function townHallApexLift(_level: number): number {
    return TOWN_HALL_STORY_H + TOWN_HALL_ROOF_H + TOWN_HALL_APEX_BALL_LIFT; // 55
}

export class BuildingRenderer {

    /**
     * Vapor and powder effects (chimney smoke, muzzle smoke, launch columns)
     * are a RUNTIME effect layer, not part of a building's body art. The
     * sprite bake turns this off so baked frames stay clean — smoke returns
     * as a separately-added effect (tools/art-preview/AGENTS_SPRITE_PIPELINE.md).
     */
    static AMBIENT_VAPOR = true;

    /**
     * Draws the Town Hall as a simple, bright building with flag.
     */
    /**
     * TOWN HALL — the Great Hall.
     *
     * The heart of the village: a two-story timber-and-stone hall with a
     * long terracotta gable, a round watchtower flying the village banner, a
     * smoking chimney, lantern-lit arched doors and a stepped entrance. It is
     * built to feel alive — the banner waves, smoke drifts, lanterns and
     * windows breathe with warm light.
     */
    /**
     * TOWN HALL — the Great Keep.
     *
     * A two-tier keep in the village's clean box-and-pyramid language: a
     * stone ground story with an arched, lantern-lit door; a walled roof
     * terrace with gold pinnacles; a timber-framed upper hall; and a
     * terracotta pyramid crown topped by a gold apex ball. Chimney smoke
     * drifts, lanterns breathe, windows glow. The village banner is NOT part
     * of this art: MainScene.updateHallBanner flies the owner's real
     * heraldry from the apex at runtime (drawVillageFlag).
     */
    /**
     * Clash-style defense footing: a compact chamfered platform just big
     * enough to carry the machine, floating on the lawn with grass visible
     * all around — never a full-footprint plate.
     */
    private static chamferPad(g: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, scale: number, topColor: number, edgeColor: number, trim: number | null = null) {
        const cut = 0.22;
        const corners = [c1, c2, c3, c4].map(a => new Phaser.Math.Vector2(
            center.x + (a.x - center.x) * scale,
            center.y + (a.y - center.y) * scale
        ));
        const ring: Phaser.Math.Vector2[] = [];
        for (let i = 0; i < 4; i++) {
            const a2 = corners[i];
            const b2 = corners[(i + 1) % 4];
            ring.push(new Phaser.Math.Vector2(a2.x + (b2.x - a2.x) * cut, a2.y + (b2.y - a2.y) * cut));
            ring.push(new Phaser.Math.Vector2(a2.x + (b2.x - a2.x) * (1 - cut), a2.y + (b2.y - a2.y) * (1 - cut)));
        }
        // Thin drop edge for thickness, then the top
        g.fillStyle(edgeColor, alpha);
        g.fillPoints(ring.map(pt => new Phaser.Math.Vector2(pt.x, pt.y + 2.5)), true);
        g.fillStyle(topColor, alpha);
        g.fillPoints(ring, true);
        if (trim !== null) {
            g.lineStyle(1.4, trim, alpha * 0.85);
            g.strokePoints(ring, true, true);
        }
    }

    /**
     * Clash-style grounding: buildings sit straight on the lawn under a soft
     * contact shadow instead of a hard-edged material plate, so the village
     * ground reads as one continuous meadow.
     *
     * Shape follows the footprint: single-tile buildings keep a round contact
     * shadow, anything larger gets a chamfered isometric rectangle that hugs
     * its actual base instead of a blob spilling past the corners.
     */
    private static groundShadow(g: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, strength: number = 1, scale: number = 0.8) {
        // (c3.y - c1.y) spans (width + height) * TILE_HEIGHT / 2 -> 1x1 == TILE_HEIGHT.
        const footprintTiles = (c3.y - c1.y) / TILE_HEIGHT;
        if (footprintTiles <= 1.2) {
            const rx = Math.max(8, (c2.x - c4.x) * 0.5 * scale);
            const ry = Math.max(4, (c3.y - c1.y) * 0.5 * scale);
            g.fillStyle(0x18220f, alpha * 0.16 * strength);
            g.fillEllipse(center.x, center.y + 1, rx * 2, ry * 2);
            g.fillStyle(0x18220f, alpha * 0.15 * strength);
            g.fillEllipse(center.x, center.y + 1, rx * 1.4, ry * 1.4);
            return;
        }

        const chamferedFootprint = (spread: number): number[][] => {
            const corners = [c1, c2, c3, c4].map(p => [
                center.x + (p.x - center.x) * spread,
                center.y + 1 + (p.y - center.y) * spread
            ]);
            // Cut each diamond corner: two points a fraction along its edges.
            const cut = 0.26;
            const poly: number[][] = [];
            for (let i = 0; i < 4; i++) {
                const prev = corners[(i + 3) % 4];
                const curr = corners[i];
                const next = corners[(i + 1) % 4];
                poly.push([curr[0] + (prev[0] - curr[0]) * cut, curr[1] + (prev[1] - curr[1]) * cut]);
                poly.push([curr[0] + (next[0] - curr[0]) * cut, curr[1] + (next[1] - curr[1]) * cut]);
            }
            return poly;
        };
        const fillPoly = (poly: number[][], a: number) => {
            g.fillStyle(0x18220f, a);
            g.beginPath();
            g.moveTo(poly[0][0], poly[0][1]);
            for (let i = 1; i < poly.length; i++) g.lineTo(poly[i][0], poly[i][1]);
            g.closePath();
            g.fillPath();
        };
        fillPoly(chamferedFootprint(scale * 1.12), alpha * 0.16 * strength);
        fillPoly(chamferedFootprint(scale * 0.8), alpha * 0.15 * strength);
    }

    static drawTownHall(graphics: Phaser.GameObjects.Graphics, gridX: number, gridY: number, time: number, alpha: number = 1, _tint: number | null = null, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, doorOpen: number = 0) {
        const info = BUILDING_DEFINITIONS['town_hall'];
        const c1 = IsoUtils.cartToIso(gridX, gridY);
        const c2 = IsoUtils.cartToIso(gridX + info.width, gridY);
        const c3 = IsoUtils.cartToIso(gridX + info.width, gridY + info.height);
        const c4 = IsoUtils.cartToIso(gridX, gridY + info.height);
        const center = IsoUtils.cartToIso(gridX + info.width / 2, gridY + info.height / 2);
        const g = baseGraphics || graphics;

        const quad = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number) => {
            gr.fillStyle(color, a);
            gr.beginPath();
            gr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
            gr.closePath();
            gr.fillPath();
        };
        const lerp = (a: Phaser.Math.Vector2, t: number): number[] => [
            center.x + (a.x - center.x) * t,
            center.y + (a.y - center.y) * t
        ];
        const up = (pt: number[], h: number): number[] => [pt[0], pt[1] - h];

        // ===== PALETTE =====
        const stone = 0xa89884;
        const stoneLit = 0xbcac96;
        const stoneDark = 0x8a7a66;
        const timber = 0x5d4037;
        const roofLit = 0xc0563c;
        const roofDark = 0x94402c;
        const roofRidge = 0x7a3222;
        const gold = 0xdaa520;
        const warm = 0xffc966;

        // ===== PLINTH =====
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.8, 0.86);
            // Simple flat stone border around the house
            const bs = 0.76;
            quad(g, [lerp(c1, bs), lerp(c2, bs), lerp(c3, bs), lerp(c4, bs)], 0x99917e, alpha);
            g.lineStyle(1.4, 0x7a7263, alpha * 0.8);
            g.lineBetween(lerp(c4, bs)[0], lerp(c4, bs)[1], lerp(c3, bs)[0], lerp(c3, bs)[1]);
            g.lineBetween(lerp(c3, bs)[0], lerp(c3, bs)[1], lerp(c2, bs)[0], lerp(c2, bs)[1]);
        }

        if (onlyBase) return;

        // ===== STORY 1 — stone hall (smaller than the plot, leaving a
        // courtyard ring for the path) =====
        const s1 = 0.62;
        const H1 = TOWN_HALL_STORY_H;
        const p2 = lerp(c2, s1);
        const p3 = lerp(c3, s1);
        const p4 = lerp(c4, s1);
        quad(graphics, [p2, p3, up(p3, H1), up(p2, H1)], stoneDark, alpha);
        quad(graphics, [p3, p4, up(p4, H1), up(p3, H1)], stoneLit, alpha);
        // Stone coursing
        graphics.lineStyle(1, 0x7a6a56, alpha * 0.5);
        for (let i = 1; i < 3; i++) {
            const hh = (H1 * i) / 3;
            graphics.lineBetween(p4[0], p4[1] - hh, p3[0], p3[1] - hh);
            graphics.lineBetween(p3[0], p3[1] - hh, p2[0], p2[1] - hh);
        }

        // Arched double door + gold studs + steps + lanterns, centred on the
        // SOUTH-WEST wall face. Everything is skewed to the face's slope so
        // the door sits flush in the wall plane (bottom parallel to the base).
        const dX = (p3[0] + p4[0]) / 2;
        const dY = (p3[1] + p4[1]) / 2 - 1;
        const sk = (p3[1] - p4[1]) / (p3[0] - p4[0]); // SW face slope (~0.5)
        const dp = (ox: number, h: number): number[] => [dX + ox, dY + ox * sk - h];
        // Step slab in front of the door
        quad(graphics, [dp(-9, -6), dp(9, -6), dp(10.5, -2.5), dp(-10.5, -2.5)], stone, alpha);
        quad(graphics, [dp(-7.5, -2.5), dp(7.5, -2.5), dp(9, 0.5), dp(-9, 0.5)], stoneDark, alpha);
        // Timber frame
        quad(graphics, [dp(-6.5, 0), dp(6.5, 0), dp(6.5, 13), dp(-6.5, 13)], timber, alpha);
        const opened = Math.max(0, Math.min(1, doorOpen));
        const panelColor = opened > 0.02 ? 0x120d09 : 0x3a2a1a;
        quad(graphics, [dp(-5, 0.5), dp(5, 0.5), dp(5, 11.5), dp(-5, 11.5)], panelColor, alpha);
        graphics.fillStyle(panelColor, alpha);
        graphics.fillCircle(dX, dY - 11.5, 5);
        if (opened > 0.02) {
            // Warm hearth light spilling out of the opening.
            graphics.fillStyle(warm, alpha * 0.3 * opened);
            graphics.fillEllipse(dX, dY - 5, 7, 8.5);
            // The two leaves swung aside — narrowing slivers at the jambs.
            const leaf = 5 * (1 - opened * 0.82);
            quad(graphics, [dp(-5, 0.5), dp(-5 + leaf, 0.5), dp(-5 + leaf, 11.5), dp(-5, 11.5)], 0x3a2a1a, alpha);
            quad(graphics, [dp(5 - leaf, 0.5), dp(5, 0.5), dp(5, 11.5), dp(5 - leaf, 11.5)], 0x3a2a1a, alpha);
        }
        if (opened < 0.3) {
            const closedAlpha = alpha * (1 - opened / 0.3);
            graphics.lineStyle(1, 0x8a6a48, closedAlpha * 0.9);
            graphics.lineBetween(dp(0, 0.5)[0], dp(0, 0.5)[1], dp(0, 12)[0], dp(0, 12)[1]);
            graphics.fillStyle(gold, closedAlpha * 0.9);
            graphics.fillCircle(dp(-2, 5)[0], dp(-2, 5)[1], 1);
            graphics.fillCircle(dp(2, 5)[0], dp(2, 5)[1], 1);
        }
        // ===== IDLE LOOP TIME BASE (exact 3000 ms period) =====
        // Lamp/window/smoke terms are integer harmonics of wIdle (the
        // chimney puffs cycle every 1500 ms = wIdle × 2), so the baked
        // ambient loop closes seamlessly. The smoke drift samples the
        // CLOSED-LOOP wind (windLoopAtScreen) — the live wind's three
        // rates never co-repeat, so it can never bake.
        const wIdle = (Math.PI * 2) / 3000;
        const lamp = 0.6 + Math.sin(time * wIdle * 2) * 0.25;
        for (const side of [-1, 1]) {
            const [lx, ly] = dp(side * 11, 9);
            graphics.fillStyle(0x2a2a2a, alpha);
            graphics.fillRect(lx - 1.6, ly - 3, 3.2, 4.6);
            graphics.fillStyle(warm, alpha * lamp);
            graphics.fillRect(lx - 1, ly - 2.4, 2, 3.4);
            graphics.fillStyle(warm, alpha * lamp * 0.22);
            graphics.fillCircle(lx, ly - 0.5, 4.5);
        }

        // Ground-story windows
        const win = (wx: number, wy: number, phase: number) => {
            const glow2 = 0.5 + Math.sin(time * wIdle + phase) * 0.22;
            quad(graphics, [[wx - 2.8, wy + 3], [wx + 2.8, wy + 4.2], [wx + 2.8, wy - 2.6], [wx - 2.8, wy - 3.8]], timber, alpha);
            quad(graphics, [[wx - 1.9, wy + 2.1], [wx + 1.9, wy + 3], [wx + 1.9, wy - 1.9], [wx - 1.9, wy - 2.8]], warm, alpha * glow2);
        };
        win((p3[0] + p4[0]) / 2 + 16, (p3[1] + p4[1]) / 2 + 8 - H1 * 0.55, 0);
        win((p2[0] + p3[0]) / 2 + 6, (p2[1] + p3[1]) / 2 - 3 - H1 * 0.5, 2.2);

        // ===== THE GREAT ROOF — one huge hipped crown, the Clash-style
        // silhouette that says "town hall" at any distance =====
        const o = 1.08;
        const roofH = TOWN_HALL_ROOF_H;
        const r1 = up(lerp(c1, s1 * o), H1);
        const r2 = up(lerp(c2, s1 * o), H1);
        const r3 = up(lerp(c3, s1 * o), H1);
        const r4 = up(lerp(c4, s1 * o), H1);
        const peak = [center.x, center.y - H1 - roofH];
        quad(graphics, [r4, r3, peak], roofLit, alpha);
        quad(graphics, [r3, r2, peak], roofDark, alpha);
        quad(graphics, [r2, r1, peak], roofDark, alpha * 0.92);
        quad(graphics, [r1, r4, peak], roofLit, alpha * 0.92);
        // Tile courses on the two visible faces
        graphics.lineStyle(1, roofRidge, alpha * 0.45);
        for (let i = 1; i <= 2; i++) {
            const t = i / 3;
            graphics.lineBetween(
                r4[0] + (peak[0] - r4[0]) * t, r4[1] + (peak[1] - r4[1]) * t,
                r3[0] + (peak[0] - r3[0]) * t, r3[1] + (peak[1] - r3[1]) * t
            );
            graphics.lineBetween(
                r3[0] + (peak[0] - r3[0]) * t, r3[1] + (peak[1] - r3[1]) * t,
                r2[0] + (peak[0] - r2[0]) * t, r2[1] + (peak[1] - r2[1]) * t
            );
        }
        // Eave line + front hips
        graphics.lineStyle(2, roofRidge, alpha * 0.8);
        graphics.lineBetween(r4[0], r4[1], r3[0], r3[1]);
        graphics.lineBetween(r3[0], r3[1], r2[0], r2[1]);
        graphics.lineBetween(r3[0], r3[1], peak[0], peak[1]);

        // Chimney on the east slope, gently smoking
        const chX = (r2[0] + peak[0]) / 2 + 4;
        const chY = (r2[1] + peak[1]) / 2 + 2;
        quad(graphics, [[chX - 3.2, chY + 3], [chX + 3.2, chY + 3], [chX + 3.2, chY - 9], [chX - 3.2, chY - 9]], stoneDark, alpha);
        quad(graphics, [[chX - 3.2, chY - 7], [chX + 3.2, chY - 7], [chX + 3.2, chY - 9], [chX - 3.2, chY - 9]], stone, alpha);
        graphics.fillStyle(0x2a2a2a, alpha);
        graphics.fillEllipse(chX, chY - 9, 5, 2);
        if (BuildingRenderer.AMBIENT_VAPOR) for (let i = 0; i < 3; i++) {
            const t = ((time / 1500) + i * 0.33) % 1;
            graphics.fillStyle(0xe8e4dc, alpha * (1 - t) * 0.5);
            graphics.fillCircle(chX + t * (3 + windLoopAtScreen(chX, chY, time, 3000) * 9) + Math.sin(t * 6 + i) * 2, chY - 11 - t * 14, 1.8 + t * 3);
        }

        // Gold apex ball only — the village banner that used to bake here is
        // now a RUNTIME layer: MainScene.updateHallBanner flies the owner's
        // REAL heraldry from this peak (drawVillageFlag plants its own pole
        // on this ball), so the baked sprite must ship no cloth of its own.
        graphics.fillStyle(gold, alpha);
        graphics.fillCircle(peak[0], peak[1] - TOWN_HALL_APEX_BALL_LIFT, 2.4);
    }

    static drawMechanicaBarracks(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: { level?: number; doorOpen?: number }, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        drawFactionBarracks(graphics, c1, c2, c3, c4, center, alpha, building, baseGraphics, skipBase, onlyBase, time, 'mechanica');
    }

    static drawMysticBarracks(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: { level?: number; doorOpen?: number }, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        drawFactionBarracks(graphics, c1, c2, c3, c4, center, alpha, building, baseGraphics, skipBase, onlyBase, time, 'mystic');
    }

    // (The deprecated pre-faction `drawBarracks` authoring reference was
    // REMOVED on 2026-07-19: both faction barracks entered a clean-room
    // redesign tournament and no old barracks art may remain visible in the
    // bundle. The body survives in git history if ever needed.)

    /**
     * WATCHTOWER — the village's far-seeing eye. A dressed-stone footing, a
     * tapered timber shaft with cross-bracing, a jettied lookout platform on
     * brackets, and a four-post canopy. A watchman turns slowly on the deck
     * and his spyglass throws a periodic glint; a brazier burns beside him
     * (the night lamp anchors there). L2 rebuilds the shaft in sandstone with
     * a deep-blue, gold-trimmed canopy and a snapping pennant.
     */
    static drawWatchtower(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        const g = baseGraphics || graphics;
        const level = Math.min(2, Math.max(1, Number(building?.level) || 1));

        // ===== PALETTE — four tiers of masonry =====
        // L1 raw timber; L2 jumps straight to the max look — warm sandstone
        // with a deep-blue canopy and gold/white ACCENTS (never masses).
        const tier = level >= 2 ? 3 : 0;
        const shaftLits = [0x8a6a42, 0x9aa2ae, 0xbfb49a, 0xcfc4a6];
        const shaftDarks = [0x6e5335, 0x7c8490, 0xa39878, 0xb3a684];
        const braceCols = [0x5c4326, 0x5a616c, 0x8a7c5c, 0xb8860b];
        const deckCols = [0xa08a64, 0xa08a64, 0xc9b593, 0xdcd3ba];
        const roofLits = [0x8a3d2f, 0x8a3d2f, 0x3a5f8a, 0x3a5f8a];
        const roofDarks = [0x6e2f24, 0x6e2f24, 0x2c4a70, 0x2c4a70];
        const trims = [0x5c4326, 0x4a5058, 0xb8860b, 0xdaa520];
        const shaftLit = shaftLits[tier];
        const shaftDark = shaftDarks[tier];
        const braceCol = braceCols[tier];
        const stoneLit = 0xb0a892;
        const stoneDark = 0x8a8272;
        const deckCol = deckCols[tier];
        const roofLit = roofLits[tier];
        const roofDark = roofDarks[tier];
        const trim = trims[tier];
        const isL2 = level >= 2; // masonry-era details from here up
        const isL4 = level >= 2;

        // ===== BASE: contact shadow + compact pad =====
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 1, 0.7);
            BuildingRenderer.chamferPad(g, c1, c2, c3, c4, center, alpha, 0.62,
                isL2 ? 0xbfb49a : 0x9a8a6a, isL2 ? 0x9a8f76 : 0x7a6a50, isL2 ? 0xdaa520 : null);
        }
        if (onlyBase) return;

        const T = time * 0.001;
        const bx = center.x;
        const by = center.y;

        // ===== STONE FOOTING (small iso box) =====
        const footW = 15;
        const footH = 9;
        graphics.fillStyle(stoneDark, alpha);
        graphics.beginPath();
        graphics.moveTo(bx - footW, by - 2);
        graphics.lineTo(bx, by + footW * 0.5 - 2);
        graphics.lineTo(bx, by + footW * 0.5 - 2 - footH);
        graphics.lineTo(bx - footW, by - 2 - footH);
        graphics.closePath();
        graphics.fillPath();
        graphics.fillStyle(stoneLit, alpha);
        graphics.beginPath();
        graphics.moveTo(bx + footW, by - 2);
        graphics.lineTo(bx, by + footW * 0.5 - 2);
        graphics.lineTo(bx, by + footW * 0.5 - 2 - footH);
        graphics.lineTo(bx + footW, by - 2 - footH);
        graphics.closePath();
        graphics.fillPath();
        // Mortar seams.
        graphics.lineStyle(0.8, 0x6e6658, alpha * 0.6);
        graphics.lineBetween(bx - footW * 0.7, by - 4.4, bx - 0.5, by + 2.4);
        graphics.lineBetween(bx + footW * 0.7, by - 4.4, bx + 0.5, by + 2.4);

        // ===== TAPERED SHAFT (two faces, narrowing upward) =====
        const baseHalf = 11;
        const topHalf = 7.5;
        const shaftBaseY = by - 2 - footH;
        const shaftTop = shaftBaseY - (isL2 ? 42 : 32); // the rebuild stands taller
        // SW face (dark)
        graphics.fillStyle(shaftDark, alpha);
        graphics.beginPath();
        graphics.moveTo(bx - baseHalf, shaftBaseY);
        graphics.lineTo(bx, shaftBaseY + baseHalf * 0.5);
        graphics.lineTo(bx, shaftTop + topHalf * 0.5);
        graphics.lineTo(bx - topHalf, shaftTop);
        graphics.closePath();
        graphics.fillPath();
        // SE face (lit)
        graphics.fillStyle(shaftLit, alpha);
        graphics.beginPath();
        graphics.moveTo(bx + baseHalf, shaftBaseY);
        graphics.lineTo(bx, shaftBaseY + baseHalf * 0.5);
        graphics.lineTo(bx, shaftTop + topHalf * 0.5);
        graphics.lineTo(bx + topHalf, shaftTop);
        graphics.closePath();
        graphics.fillPath();
        // Corner edge highlight.
        graphics.lineStyle(1.2, isL2 ? 0xe8dcc0 : 0xa08050, alpha * 0.9);
        graphics.lineBetween(bx, shaftBaseY + baseHalf * 0.5, bx, shaftTop + topHalf * 0.5);
        // Cross-bracing on both faces.
        graphics.lineStyle(1.3, braceCol, alpha);
        for (const side of [-1, 1]) {
            const b0 = baseHalf * side;
            const t0 = topHalf * side;
            graphics.lineBetween(bx + b0 * 0.9, shaftBaseY - 2, bx + t0 * 0.3, shaftTop + 10);
            graphics.lineBetween(bx + b0 * 0.25, shaftBaseY + 2, bx + t0 * 0.95, shaftTop + 8);
        }
        // Arrow slit on the lit face.
        graphics.fillStyle(0x2c2418, alpha);
        graphics.fillRect(bx + 4.4, shaftTop + 14, 2, 6);

        // ===== JETTIED LOOKOUT PLATFORM =====
        const deckHalf = 13;
        const deckY = shaftTop - 1;
        // Support brackets.
        graphics.lineStyle(1.6, braceCol, alpha);
        graphics.lineBetween(bx - topHalf, shaftTop + 4, bx - deckHalf + 1.5, deckY + 2);
        graphics.lineBetween(bx + topHalf, shaftTop + 4, bx + deckHalf - 1.5, deckY + 2);
        // Deck slab (iso diamond).
        graphics.fillStyle(deckCol, alpha);
        graphics.beginPath();
        graphics.moveTo(bx, deckY - deckHalf * 0.5);
        graphics.lineTo(bx + deckHalf, deckY);
        graphics.lineTo(bx, deckY + deckHalf * 0.5);
        graphics.lineTo(bx - deckHalf, deckY);
        graphics.closePath();
        graphics.fillPath();
        // Deck edge (front faces).
        graphics.fillStyle(isL2 ? 0xb3a684 : 0x8a744e, alpha);
        graphics.beginPath();
        graphics.moveTo(bx - deckHalf, deckY);
        graphics.lineTo(bx, deckY + deckHalf * 0.5);
        graphics.lineTo(bx, deckY + deckHalf * 0.5 + 3);
        graphics.lineTo(bx - deckHalf, deckY + 3);
        graphics.closePath();
        graphics.fillPath();
        graphics.beginPath();
        graphics.moveTo(bx + deckHalf, deckY);
        graphics.lineTo(bx, deckY + deckHalf * 0.5);
        graphics.lineTo(bx, deckY + deckHalf * 0.5 + 3);
        graphics.lineTo(bx + deckHalf, deckY + 3);
        graphics.closePath();
        graphics.fillPath();
        // Plank seams.
        graphics.lineStyle(0.7, braceCol, alpha * 0.7);
        for (let s = -2; s <= 2; s++) {
            graphics.lineBetween(bx + s * 3 - deckHalf * 0.4, deckY + Math.abs(s) * 0.8 - deckHalf * 0.22, bx + s * 3 + deckHalf * 0.4, deckY + Math.abs(s) * 0.8 + deckHalf * 0.22);
        }
        // Railing around the two camera-facing edges.
        graphics.lineStyle(1.1, trim, alpha);
        for (let r = 0; r <= 4; r++) {
            const t = r / 4;
            const rx = bx - deckHalf + deckHalf * t;
            const ry = deckY + deckHalf * 0.5 * t;
            graphics.lineBetween(rx, ry + 1, rx, ry - 5);
            const rx2 = bx + deckHalf - deckHalf * t;
            graphics.lineBetween(rx2, ry + 1, rx2, ry - 5);
        }
        graphics.lineBetween(bx - deckHalf, deckY - 4, bx, deckY + deckHalf * 0.5 - 4);
        graphics.lineBetween(bx + deckHalf, deckY - 4, bx, deckY + deckHalf * 0.5 - 4);

        // ===== THE WATCHMAN (slow scan) + SPYGLASS GLINT =====
        const scan = Math.sin(T * 0.6 + (Number(building?.gridX) || 0));
        const wmX = bx + scan * 3.5;
        const wmY = deckY - 6;
        graphics.fillStyle(0x4a4258, alpha);
        graphics.fillTriangle(wmX - 2.6, wmY + 5, wmX + 2.6, wmY + 5, wmX, wmY - 3.5);
        graphics.fillStyle(0xd9b38c, alpha);
        graphics.fillCircle(wmX, wmY - 4.6, 1.9);
        // Spyglass toward scan direction.
        graphics.lineStyle(1.3, 0x5c4326, alpha);
        graphics.lineBetween(wmX + 1.5 * Math.sign(scan || 1), wmY - 4, wmX + 5 * Math.sign(scan || 1), wmY - 5.2);
        // The glint: a brief star at the spyglass tip, every few seconds.
        const glintGate = Math.max(0, Math.sin(T * 1.4 + 1.1));
        if (glintGate > 0.965) {
            const gx2 = wmX + 5.6 * Math.sign(scan || 1);
            const gy2 = wmY - 5.4;
            const flare = (glintGate - 0.965) / 0.035;
            graphics.fillStyle(0xffffff, alpha * flare);
            graphics.fillTriangle(gx2 - 3.4, gy2, gx2 + 3.4, gy2, gx2, gy2 - 1.2);
            graphics.fillTriangle(gx2 - 3.4, gy2, gx2 + 3.4, gy2, gx2, gy2 + 1.2);
            graphics.fillTriangle(gx2, gy2 - 3.4, gx2, gy2 + 3.4, gx2 - 1.2, gy2);
            graphics.fillTriangle(gx2, gy2 - 3.4, gx2, gy2 + 3.4, gx2 + 1.2, gy2);
        }

        // ===== BRAZIER (the night lamp anchor) =====
        const brX = bx - 8;
        const brY = deckY - 3;
        graphics.fillStyle(0x3c3222, alpha);
        graphics.fillRect(brX - 1.9, brY - 3, 3.8, 3);
        graphics.lineStyle(1, 0x3c3222, alpha);
        graphics.lineBetween(brX - 2.6, brY, brX + 2.6, brY);
        const lick = Math.sin(T * 16 + 2) * 1.1;
        graphics.fillStyle(0xff7a2a, alpha * 0.95);
        graphics.fillTriangle(brX - 1.7, brY - 3, brX + 1.7, brY - 3, brX + lick * 0.4, brY - 7.5 - Math.abs(lick));
        graphics.fillStyle(0xffc36a, alpha * 0.95);
        graphics.fillTriangle(brX - 1, brY - 3, brX + 1, brY - 3, brX + lick * 0.3, brY - 5.4 - Math.abs(lick) * 0.6);

        // ===== CANOPY: four posts + pyramid roof =====
        const roofBaseY = deckY - 14;
        const apexY = roofBaseY - (isL2 ? 15 : 11);
        const roofHalf = deckHalf - 1.5;
        graphics.lineStyle(1.4, trim, alpha);
        graphics.lineBetween(bx - deckHalf + 1.5, deckY + 0.5, bx - roofHalf, roofBaseY);
        graphics.lineBetween(bx + deckHalf - 1.5, deckY + 0.5, bx + roofHalf, roofBaseY);
        graphics.lineBetween(bx, deckY + deckHalf * 0.5 - 1, bx, roofBaseY + roofHalf * 0.5);
        // Roof faces.
        graphics.fillStyle(roofDark, alpha);
        graphics.beginPath();
        graphics.moveTo(bx - roofHalf, roofBaseY);
        graphics.lineTo(bx, roofBaseY + roofHalf * 0.5);
        graphics.lineTo(bx, apexY);
        graphics.closePath();
        graphics.fillPath();
        graphics.fillStyle(roofLit, alpha);
        graphics.beginPath();
        graphics.moveTo(bx + roofHalf, roofBaseY);
        graphics.lineTo(bx, roofBaseY + roofHalf * 0.5);
        graphics.lineTo(bx, apexY);
        graphics.closePath();
        graphics.fillPath();
        // Eave trim.
        graphics.lineStyle(1.3, trim, alpha);
        graphics.lineBetween(bx - roofHalf, roofBaseY, bx, roofBaseY + roofHalf * 0.5);
        graphics.lineBetween(bx + roofHalf, roofBaseY, bx, roofBaseY + roofHalf * 0.5);
        // Finial + pennant.
        graphics.lineStyle(1.2, trim, alpha);
        graphics.lineBetween(bx, apexY, bx, apexY - 7);
        if (isL2) {
            graphics.fillStyle(0xffd700, alpha);
            graphics.fillCircle(bx, apexY - 7.5, 2);
        }
        if (isL4) {
            // A whisper of gold along the eaves — accent, never a mass.
            graphics.lineStyle(1, 0xffd700, alpha * 0.85);
            graphics.lineBetween(bx - roofHalf, roofBaseY - 0.8, bx, apexY + 1);
            graphics.lineBetween(bx + roofHalf, roofBaseY - 0.8, bx, apexY + 1);
        }
        const wave = Math.sin(T * 6 + (Number(building?.gridY) || 0)) * 1.6;
        graphics.fillStyle(isL4 ? 0xf4ecd8 : 0xd8563c, alpha);
        graphics.fillTriangle(bx, apexY - 6.5, bx + 8, apexY - 5 + wave, bx, apexY - 2.5);
    }

    static drawLab(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: any, time: number = 0, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        const g = baseGraphics || graphics;
        const level = Number(building?.level) || 1;
        const isL2 = level >= 2;
        const isL3 = level >= 3;

        const quad = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number) => {
            gr.fillStyle(color, a);
            gr.beginPath();
            gr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
            gr.closePath();
            gr.fillPath();
        };
        const lerp = (a: Phaser.Math.Vector2, t: number) => [
            center.x + (a.x - center.x) * t,
            center.y + (a.y - center.y) * t
        ];

        // ===== PALETTE =====
        const wallLit = isL3 ? 0xf1f1e4 : isL2 ? 0x9a9aa8 : 0xd8ccab;
        const wallDark = isL3 ? 0xd6d6c4 : isL2 ? 0x767684 : 0xb3a684;
        const frame = isL3 ? 0xb8860b : isL2 ? 0x55555f : 0x5d4037;
        const roofLit = isL3 ? 0x7a55c8 : isL2 ? 0x6644aa : 0x5c4a86;
        const roofDark = isL3 ? 0x5c3f9a : isL2 ? 0x4e3384 : 0x463868;
        const copper = isL3 ? 0xd9912f : 0xb06a3a;
        const copperDark = isL3 ? 0xa0651b : 0x7e4826;
        const liquid = isL3 ? 0xffd76a : isL2 ? 0xb37cff : 0x59e08f;
        const liquidHi = isL3 ? 0xfff2c0 : isL2 ? 0xd9bcff : 0xa8f0c8;

        // ===== FLAGSTONE PAD =====
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 1, 0.78);
        }

        if (onlyBase) return;

        // ===== MAIN HALL (iso box on a shrunken footprint) =====
        const s = 0.68;
        const wallH = isL3 ? 23 : isL2 ? 20 : 17;
        const p2 = lerp(c2, s); // east
        const p3 = lerp(c3, s); // south
        const p4 = lerp(c4, s); // west
        const up = (pt: number[], h: number) => [pt[0], pt[1] - h];

        // South-east face (darker)
        quad(graphics, [p2, p3, up(p3, wallH), up(p2, wallH)], wallDark, alpha);
        // South-west face (lit)
        quad(graphics, [p3, p4, up(p4, wallH), up(p3, wallH)], wallLit, alpha);

        if (!isL2) {
            // Timber framing on the L1 workshop
            graphics.lineStyle(2.4, frame, alpha);
            graphics.lineBetween(p3[0], p3[1], p3[0], p3[1] - wallH);
            graphics.lineBetween(p4[0], p4[1], p4[0], p4[1] - wallH);
            graphics.lineBetween(p2[0], p2[1], p2[0], p2[1] - wallH);
            graphics.lineBetween(p4[0], p4[1] - wallH * 0.55, p3[0], p3[1] - wallH * 0.55);
            graphics.lineBetween(p3[0], p3[1] - wallH * 0.55, p2[0], p2[1] - wallH * 0.55);
            // Diagonal brace
            graphics.lineBetween(p4[0], p4[1] - wallH * 0.55, (p4[0] + p3[0]) / 2, p3[1] - 2);
        } else {
            // Stone/marble coursing
            graphics.lineStyle(1, isL3 ? 0xc9c9b4 : 0x5f5f6c, alpha * 0.5);
            for (let i = 1; i < 3; i++) {
                const hh = (wallH * i) / 3;
                graphics.lineBetween(p4[0], p4[1] - hh, p3[0], p3[1] - hh);
                graphics.lineBetween(p3[0], p3[1] - hh, p2[0], p2[1] - hh);
            }
        }

        // Door on the SW face
        const doorX = (p3[0] + p4[0]) / 2 - 4;
        const doorBaseY = (p3[1] + p4[1]) / 2 - 2;
        const labDoorOpen = Math.max(0, Math.min(1, (building as { doorOpen?: number } | undefined)?.doorOpen ?? 0));
        if (labDoorOpen > 0.02) {
            quad(graphics, [
                [doorX - 4, doorBaseY], [doorX + 4, doorBaseY + 2],
                [doorX + 4, doorBaseY - 9], [doorX - 4, doorBaseY - 11]
            ], 0x110d09, alpha);
            // Eerie potion glow from inside the lab.
            graphics.fillStyle(0x7fe7c9, alpha * 0.2 * labDoorOpen);
            graphics.fillEllipse(doorX, doorBaseY - 4, 5.5, 7);
            const leaf = 8 * (1 - labDoorOpen * 0.85);
            quad(graphics, [
                [doorX - 4, doorBaseY], [doorX - 4 + leaf, doorBaseY + 1], [doorX - 4 + leaf, doorBaseY - 10], [doorX - 4, doorBaseY - 11]
            ], 0x3a2a1a, alpha);
        } else {
            quad(graphics, [
                [doorX - 4, doorBaseY], [doorX + 4, doorBaseY + 2],
                [doorX + 4, doorBaseY - 9], [doorX - 4, doorBaseY - 11]
            ], 0x3a2a1a, alpha);
        }
        // ===== IDLE LOOP TIME BASE (exact 3000 ms period) =====
        // Every idle term below (window pulse, slosh, bubbles, drip, orrery)
        // is an integer harmonic of labW so the baked ambient loop closes.
        const labW = (Math.PI * 2) / 3000;

        // Glowing window on the SE face (potion light)
        const winPulse = 0.55 + Math.sin(time * labW) * 0.2;
        const wx = (p2[0] + p3[0]) / 2 + 2;
        const wy = (p2[1] + p3[1]) / 2 - wallH * 0.52;
        quad(graphics, [
            [wx - 3.4, wy + 3], [wx + 3.4, wy + 1.6], [wx + 3.4, wy - 4], [wx - 3.4, wy - 2.6]
        ], 0x1e1826, alpha);
        quad(graphics, [
            [wx - 2.4, wy + 2.2], [wx + 2.4, wy + 1], [wx + 2.4, wy - 3.2], [wx - 2.4, wy - 2]
        ], liquid, alpha * winPulse);

        // ===== ROOF SLAB (overhanging diamond) =====
        const o = 1.14;
        const r1 = up(lerp(c1, s * o), wallH);
        const r2 = up(lerp(c2, s * o), wallH);
        const r3 = up(lerp(c3, s * o), wallH);
        const r4 = up(lerp(c4, s * o), wallH);
        const peak = [center.x - 2, center.y - wallH - 11];
        // Slate panels toward the peak
        quad(graphics, [r4, r3, peak], roofLit, alpha);
        quad(graphics, [r3, r2, peak], roofDark, alpha);
        quad(graphics, [r2, r1, peak], roofDark, alpha * 0.92);
        quad(graphics, [r1, r4, peak], roofLit, alpha * 0.92);
        graphics.lineStyle(1.6, isL3 ? 0xdaa520 : roofDark, alpha * 0.9);
        graphics.lineBetween(r4[0], r4[1], r3[0], r3[1]);
        graphics.lineBetween(r3[0], r3[1], r2[0], r2[1]);
        if (isL3) {
            graphics.lineStyle(1.2, 0xffd700, alpha * 0.8);
            graphics.lineBetween(r3[0], r3[1], peak[0], peak[1]);
        }

        // ===== THE RETORT (glass bulb of glowing liquid on the roof) =====
        const bulbR = isL3 ? 10 : isL2 ? 9 : 8;
        const bulbX = center.x - 2;
        const bulbY = center.y - wallH - 14 - bulbR * 0.7;

        // Copper cradle arms holding the bulb to the roof peak
        graphics.lineStyle(2.6, copperDark, alpha);
        graphics.lineBetween(bulbX - bulbR * 0.7, bulbY + bulbR * 0.6, peak[0] - 4, peak[1] + 2);
        graphics.lineBetween(bulbX + bulbR * 0.7, bulbY + bulbR * 0.6, peak[0] + 4, peak[1] + 2);

        // Liquid inside (drawn first, glass over) with a sloshing surface
        const slosh = Math.sin(time * labW + 1.7) * 1.4;
        graphics.fillStyle(liquid, alpha * 0.9);
        graphics.fillEllipse(bulbX, bulbY + bulbR * 0.32, bulbR * 1.62, bulbR * 1.05);
        graphics.fillStyle(liquidHi, alpha * 0.8);
        graphics.fillEllipse(bulbX + slosh, bulbY + bulbR * 0.02, bulbR * 1.3, bulbR * 0.34);
        // Bubbles rising on a deterministic clock (750 ms — 4 cycles per loop)
        for (let i = 0; i < 3; i++) {
            const t = ((time / 750) + i * 0.37) % 1;
            const bx = bulbX + Math.sin(i * 2.4 + t * 5) * bulbR * 0.34;
            const by = bulbY + bulbR * 0.42 - t * bulbR * 0.85;
            graphics.fillStyle(liquidHi, alpha * (1 - t) * 0.9);
            graphics.fillCircle(bx, by, 1 + (1 - t) * 0.8);
        }
        // Glass shell: rim + specular
        graphics.lineStyle(1.6, 0xcfeef8, alpha * 0.75);
        graphics.strokeCircle(bulbX, bulbY, bulbR);
        graphics.fillStyle(0xffffff, alpha * 0.35);
        graphics.fillCircle(bulbX - bulbR * 0.4, bulbY - bulbR * 0.4, bulbR * 0.22);
        // Neck + cork
        graphics.fillStyle(0xcfeef8, alpha * 0.55);
        graphics.fillRect(bulbX - 2, bulbY - bulbR - 5, 4, 6);
        graphics.fillStyle(frame, alpha);
        graphics.fillRect(bulbX - 2.6, bulbY - bulbR - 7.5, 5.2, 3);

        // ===== COPPER PIPEWORK down into a condenser keg =====
        const kegX = p4[0] + 6;
        const kegY = p4[1] + 3;
        graphics.lineStyle(2.8, copper, alpha);
        graphics.lineBetween(bulbX - bulbR * 0.85, bulbY + bulbR * 0.35, p4[0] + 9, p4[1] - wallH * 0.6);
        graphics.lineBetween(p4[0] + 9, p4[1] - wallH * 0.6, kegX + 2, kegY - 9);
        graphics.lineStyle(1.2, copperDark, alpha * 0.8);
        graphics.lineBetween(bulbX - bulbR * 0.85, bulbY + bulbR * 0.35 + 1.4, p4[0] + 9, p4[1] - wallH * 0.6 + 1.4);
        // Keg
        graphics.fillStyle(0x111111, alpha * 0.3);
        graphics.fillEllipse(kegX, kegY + 4.5, 12, 4.5);
        graphics.fillStyle(0x5d4037, alpha);
        graphics.fillRect(kegX - 4.5, kegY - 8, 9, 12);
        graphics.fillStyle(0x795548, alpha);
        graphics.fillRect(kegX - 4.5, kegY - 8, 3.4, 12);
        graphics.lineStyle(1.4, copperDark, alpha);
        graphics.lineBetween(kegX - 5, kegY - 5.5, kegX + 5, kegY - 5.5);
        graphics.lineBetween(kegX - 5, kegY + 0.5, kegX + 5, kegY + 0.5);
        graphics.fillStyle(0x795548, alpha);
        graphics.fillEllipse(kegX, kegY - 8, 9, 3.6);
        // Drip glow where the pipe meets the keg (1500 ms — harmonic 2)
        const drip = 0.5 + Math.sin(time * labW * 2 + 0.8) * 0.35;
        graphics.fillStyle(liquid, alpha * drip);
        graphics.fillCircle(kegX + 2, kegY - 8.5, 1.6);

        // ===== FLASK SHELF (L2+): three little potions by the door =====
        if (isL2) {
            const sx = p3[0] + 2;
            const sy = p3[1] + 1;
            graphics.fillStyle(frame, alpha);
            graphics.fillRect(sx - 8, sy - 6, 16, 2);
            graphics.lineStyle(1.6, frame, alpha);
            graphics.lineBetween(sx - 7, sy - 4, sx - 7, sy + 1);
            graphics.lineBetween(sx + 7, sy - 4, sx + 7, sy + 1);
            const flaskColors = [0xff6a6a, 0x6ab8ff, 0x8dff7a];
            for (let i = 0; i < 3; i++) {
                const fx = sx - 4.5 + i * 4.5;
                graphics.fillStyle(flaskColors[i], alpha * 0.9);
                graphics.fillCircle(fx, sy - 8, 1.9);
                graphics.fillStyle(0xcfeef8, alpha * 0.5);
                graphics.fillRect(fx - 0.7, sy - 11.4, 1.4, 2.4);
            }
        }

        // ===== ORRERY (L3): brass rings swinging around the retort =====
        if (isL3) {
            const swing = Math.sin(time * labW);
            graphics.lineStyle(1.6, 0xdaa520, alpha * 0.9);
            graphics.strokeEllipse(bulbX, bulbY, bulbR * 2.5, bulbR * (0.7 + 0.5 * Math.abs(swing)));
            graphics.lineStyle(1.2, 0xffd700, alpha * 0.75);
            graphics.strokeEllipse(bulbX, bulbY, bulbR * (0.7 + 0.5 * Math.abs(Math.cos(time * labW))), bulbR * 2.5);
            // Two orbiting motes (one orbit per loop)
            for (let i = 0; i < 2; i++) {
                const a2 = time * labW + i * Math.PI;
                graphics.fillStyle(0xffd700, alpha * 0.95);
                graphics.fillCircle(bulbX + Math.cos(a2) * bulbR * 1.25, bulbY + Math.sin(a2) * bulbR * 0.42, 1.7);
            }
        }
    }

    static drawCannon(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        // Canonical cannon = tournament winner B (see redesign/CannonB.ts).
        drawCannonB(graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }

    static drawCannonLevel2(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        drawCannonB(graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }

    static drawCannonLevel3(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        drawCannonB(graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }

    static drawCannonLevel4(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        drawCannonB(graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }


    static drawBallista(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        BuildingRenderer.renderBallistaV2(1, graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }

    static drawBallistaLevel2(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        BuildingRenderer.renderBallistaV2(2, graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }

    static drawBallistaLevel3(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        BuildingRenderer.renderBallistaV2(3, graphics, c1, c2, c3, c4, center, alpha, tint, building, baseGraphics, skipBase, onlyBase, time);
    }

    /**
     * BALLISTA — a torsion-powered siege scorpio.
     *
     * The machine's power source is made visible: two rope-wound torsion
     * housings flank the front of the rail and the limbs grow out of them
     * (that is how a real scorpio works). The whole machine sits on a planked
     * turntable whose seams rotate with the aim.
     *
     * Story across levels: timber scorpio (L1) -> iron arbalest (L2) ->
     * marble-and-gold storm piercer (L3).
     *
     * building fields used: ballistaAngle, ballistaStringTension (0..1),
     * ballistaBoltLoaded, lastFireTime.
     */
    private static renderBallistaV2(level: number, graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        const g = baseGraphics || graphics;
        const isL2 = level >= 2;
        const isL3 = level >= 3;

        const angle = building?.ballistaAngle ?? 0;
        const tension = building?.ballistaStringTension ?? 0;
        const boltLoaded = building?.ballistaBoltLoaded ?? true;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const H = -26; // rail height above the deck

        // Aim-space transforms (iso Y squashed x0.5)
        const ax = (d: number) => cos * d;
        const ay = (d: number) => sin * 0.5 * d;
        const px = (w: number) => -sin * w;
        const py = (w: number) => cos * 0.5 * w;
        // A point at distance d along the aim, offset w across it, at height h
        const P = (d: number, w: number, h: number) => [
            center.x + ax(d) + px(w),
            center.y + h + ay(d) + py(w)
        ];

        const quad = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number) => {
            gr.fillStyle(color, a);
            gr.beginPath();
            gr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
            gr.closePath();
            gr.fillPath();
        };

        // ===== PALETTE =====
        const woodDark = isL3 ? 0x4a3520 : 0x3f2a18;
        const woodMid = isL3 ? 0x6b4a2a : 0x5d4037;
        const woodLight = isL3 ? 0x8a6238 : 0x795548;
        const limbDark = isL3 ? 0xcfcfc2 : isL2 ? 0x2e2e38 : woodDark;
        const limbMid = isL3 ? 0xe8e8da : isL2 ? 0x454552 : woodMid;
        const ironMid = isL3 ? 0xb8860b : 0x4a4a4a;
        const ironLight = isL3 ? 0xffd700 : 0x6a6a72;
        const rope = isL3 ? 0xd8b96a : 0xb8a07a;
        const stringC = isL3 ? 0xffe9a0 : 0xe8e0d0;

        // ===== RAISED DECK =====
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.85, 0.78);
            BuildingRenderer.chamferPad(g, c1, c2, c3, c4, center, alpha, 0.66,
                isL3 ? 0xcfc5ae : isL2 ? 0x50505a : 0x8a7355,
                isL3 ? 0xafa58c : isL2 ? 0x33333c : 0x5f4d38,
                isL3 ? 0xdaa520 : null);
        }

        if (onlyBase) return;

        // ===== IDLE LOOP (elevated pass only; exact 1500 ms ambient period)
        // Every term below repeats exactly every IDLE_P ms — the sprite bake
        // measures this loop by autocorrelation and replays it as frames.
        const IDLE_P = 1500;
        const iw = (Math.PI * 2) / IDLE_P;
        // Windlass ratchet: the crank bar does ONE full revolution per loop
        // in 4 discrete 90° notches — a step function of time, nothing else.
        const idleNotch = Math.floor(((time % IDLE_P) / IDLE_P) * 4);
        const crankA = 0.6 + idleNotch * (Math.PI / 2);
        // Torsion-skein breathing: the two rope bundles work in opposition.
        const skein = (side: number) => Math.sin(time * iw + (side < 0 ? 0 : Math.PI));
        // Staggered specular windows cycling across the metal fittings.
        const glintOn = (ph: number) => Math.cos(time * iw + ph) > 0.55;

        // ===== STATIC PROP: bolt quiver near the east corner =====
        const qx = center.x + 34;
        const qy = center.y + 2;
        graphics.fillStyle(0x111111, alpha * 0.3);
        graphics.fillEllipse(qx, qy + 5, 12, 4.5);
        quad(graphics, [[qx - 4, qy + 4], [qx + 4, qy + 4], [qx + 5.5, qy - 6], [qx - 2.5, qy - 6]], woodMid, alpha);
        quad(graphics, [[qx - 4, qy + 4], [qx - 2.5, qy - 6], [qx - 0.5, qy - 6], [qx - 2, qy + 4]], woodLight, alpha);
        graphics.lineStyle(1.6, isL3 ? 0xb8860b : 0x8a7355, alpha);
        graphics.lineBetween(qx - 1, qy - 6, qx - 3, qy - 13);
        graphics.lineBetween(qx + 1.6, qy - 6, qx + 1.6, qy - 14);
        graphics.lineBetween(qx + 4, qy - 6, qx + 6.5, qy - 12);
        graphics.fillStyle(isL3 ? 0xdaa520 : 0x9c2b2b, alpha);
        graphics.fillCircle(qx - 3, qy - 13, 1.2);
        graphics.fillCircle(qx + 1.6, qy - 14, 1.2);
        graphics.fillCircle(qx + 6.5, qy - 12, 1.2);

        // ===== TURNTABLE =====
        graphics.fillStyle(0x111111, alpha * 0.35);
        graphics.fillEllipse(center.x + 2, center.y + 2, 42, 22);
        graphics.fillStyle(woodDark, alpha);
        graphics.fillEllipse(center.x, center.y - 2, 40, 21);
        graphics.fillStyle(woodMid, alpha);
        graphics.fillEllipse(center.x, center.y - 3, 36, 19);
        // Plank seams that rotate with the aim — the table visibly turns
        graphics.lineStyle(1, woodDark, alpha * 0.8);
        for (const t of [-0.62, -0.22, 0.22, 0.62]) {
            graphics.lineBetween(
                center.x + ax(-16) + px(t * 27), center.y - 3 + ay(-16) + py(t * 27),
                center.x + ax(16) + px(t * 27), center.y - 3 + ay(16) + py(t * 27)
            );
        }
        graphics.lineStyle(2.4, ironMid, alpha * 0.9);
        graphics.strokeEllipse(center.x, center.y - 3, 36, 19);

        // ===== KING-POST (squared block, carries the rail) =====
        const kw = 6.5;
        quad(graphics, [ // south-east face
            [center.x + kw, center.y - 3], [center.x, center.y - 3 + kw * 0.5],
            [center.x, center.y + H + 4 + kw * 0.5], [center.x + kw, center.y + H + 4]
        ], woodDark, alpha);
        quad(graphics, [ // south-west face
            [center.x - kw, center.y - 3], [center.x, center.y - 3 + kw * 0.5],
            [center.x, center.y + H + 4 + kw * 0.5], [center.x - kw, center.y + H + 4]
        ], woodMid, alpha);
        quad(graphics, [ // top
            [center.x, center.y + H + 4 - kw * 0.5], [center.x + kw, center.y + H + 4],
            [center.x, center.y + H + 4 + kw * 0.5], [center.x - kw, center.y + H + 4]
        ], woodLight, alpha);

        // ===== MACHINE PIECES (closures for aim-aware layering) =====
        const railBack = -33;
        const railFront = 31;

        const drawRail = () => {
            // Rail: under-shade, body, lit top edge
            const w = 4.4;
            quad(graphics, [
                P(railBack, w, H + 2.2), P(railBack, -w, H + 2.2),
                P(railFront, -w, H + 2.2), P(railFront, w, H + 2.2)
            ], woodDark, alpha);
            quad(graphics, [
                P(railBack, w, H), P(railBack, -w, H),
                P(railFront, -w, H), P(railFront, w, H)
            ], woodMid, alpha);
            quad(graphics, [
                P(railBack, -w * 0.55, H - 1.4), P(railBack, -w * 0.05, H - 1.4),
                P(railFront, -w * 0.05, H - 1.4), P(railFront, -w * 0.55, H - 1.4)
            ], woodLight, alpha * 0.85);
            // Bolt groove
            graphics.lineStyle(1.2, woodDark, alpha * 0.8);
            graphics.lineBetween(P(railBack + 3, 0, H - 1)[0], P(railBack + 3, 0, H - 1)[1], P(railFront - 1, 0, H - 1)[0], P(railFront - 1, 0, H - 1)[1]);

        };

        const drawWinch = () => {
            // Windlass across the rear of the rail with crank handles that
            // spin as the string is drawn (tension drives the crank angle).
            const d = railBack + 3;
            const axleW = 11;
            const [x1, y1] = P(d, axleW, H + 1);
            const [x2, y2] = P(d, -axleW, H + 1);
            graphics.lineStyle(5.4, woodDark, alpha);
            graphics.lineBetween(x1, y1, x2, y2);
            graphics.lineStyle(3, woodLight, alpha);
            graphics.lineBetween(x1, y1, x2, y2);
            let winchEnd = 0;
            for (const [ex, ey] of [[x1, y1], [x2, y2]]) {
                graphics.fillStyle(ironMid, alpha);
                graphics.fillCircle(ex, ey, 3.2);
                graphics.fillStyle(ironLight, alpha * 0.7);
                graphics.fillCircle(ex - 0.8, ey - 0.8, 1.3);
                // Idle ratchet crank: a rigid handle bar through the axle.
                // It turns in the along-aim/vertical plane (perpendicular to
                // the axle), so along-aim uses ax/ay and vertical is raw.
                const armR = 5.2;
                const tipX = ex + ax(Math.cos(crankA) * armR);
                const tipY = ey + ay(Math.cos(crankA) * armR) - Math.sin(crankA) * armR;
                graphics.lineStyle(1.8, ironMid, alpha);
                graphics.lineBetween(ex, ey, tipX, tipY);
                graphics.fillStyle(isL3 ? 0xffd700 : ironLight, alpha);
                graphics.fillCircle(tipX, tipY, 1.7);
                // Specular window on the axle cap (ends alternate)
                if (glintOn(winchEnd * Math.PI)) {
                    graphics.fillStyle(isL3 ? 0xfff2c0 : 0xd8dce0, alpha * 0.9);
                    graphics.fillCircle(ex - 1, ey - 1.2, 1.4);
                }
                winchEnd++;
            }
        };

        // Torsion housings + limbs, the scorpio's power plant. The housings
        // straddle the middle of the rail so the drawn string and the loaded
        // bolt both live on the rail (no overhang at rest).
        const housingD = 9;
        const housingW = 15.5;
        const tipD = housingD + 12;
        const tipW = housingW + 19;
        // Tapered strip with true screen-space thickness (perpendicular to
        // the segment, not merely vertical) so limbs read as curved blades.
        const strip = (a: number[], b: number[], wa: number, wb: number, color: number) => {
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const len = Math.max(0.001, Math.hypot(dx, dy));
            const nx = -dy / len;
            const ny = dx / len;
            quad(graphics, [
                [a[0] + nx * wa, a[1] + ny * wa],
                [b[0] + nx * wb, b[1] + ny * wb],
                [b[0] - nx * wb, b[1] - ny * wb],
                [a[0] - nx * wa, a[1] - ny * wa]
            ], color, alpha);
        };
        const drawPowerPlant = () => {
            for (const side of [-1, 1]) {
                const [hx, hy] = P(housingD, side * housingW, H + 9);
                const hh = 15;
                const r = 5.2;
                // Vertical cylinder: bottom ellipse, wall, lit top
                graphics.fillStyle(woodDark, alpha);
                graphics.fillEllipse(hx, hy, r * 2, r);
                graphics.fillStyle(woodMid, alpha);
                graphics.fillRect(hx - r, hy - hh, r * 2, hh);
                graphics.fillStyle(0x000000, alpha * 0.18);
                graphics.fillRect(hx + r * 0.25, hy - hh, r * 0.75, hh);
                // Rope windings
                // Skein breathing: the windings creep as the bundle works
                const br = skein(side);
                graphics.lineStyle(1.6, rope, alpha);
                for (let i = 1; i <= 2; i++) {
                    graphics.lineBetween(hx - r + 0.5, hy - (hh * i) / 3 + br * 0.9, hx + r - 0.5, hy - (hh * i) / 3 - 0.8 + br * 0.9);
                }
                // ...and the twisted bundle's sheen slides across the housing
                const shx = hx - 1 + br * 2.0;
                graphics.fillStyle(isL3 ? 0xe8d8a8 : 0xcdb890, alpha * 0.38);
                graphics.fillRect(shx - 1.1, hy - hh + 1.5, 2.2, hh - 3.5);
                // Cap
                graphics.fillStyle(isL3 ? 0xdaa520 : isL2 ? ironMid : woodLight, alpha);
                graphics.fillEllipse(hx, hy - hh, r * 2 + 1, r + 0.5);
                // Max level: a gold finial glint sweeps the two caps in turn
                if (isL3 && glintOn(side < 0 ? Math.PI / 4 : (5 * Math.PI) / 4)) {
                    graphics.fillStyle(0xfff6d0, alpha * 0.95);
                    graphics.fillCircle(hx - 1.5, hy - hh - 0.5, 1.3);
                }

                // Limb: grows out of the housing, sweeping outward then
                // curling forward — two tapered blade segments
                const k1 = P(housingD - 1.5, side * (housingW + 0.5), H - 6);
                const k3 = P(tipD, side * tipW, H - 9.5);
                strip(k1, k3, 3.6, 1.8, limbMid);
                graphics.lineStyle(1.1, limbDark, alpha * 0.8);
                graphics.lineBetween(k1[0], k1[1], k3[0], k3[1]);
                // Limb tip cap
                graphics.fillStyle(isL3 ? 0xffd700 : ironMid, alpha);
                graphics.fillCircle(k3[0], k3[1], 2.8);
                // Specular window on the tip fitting (sides stagger the cycle)
                if (glintOn(side < 0 ? Math.PI / 2 : (3 * Math.PI) / 2)) {
                    graphics.fillStyle(isL3 ? 0xfff2c0 : 0xd8dce0, alpha * 0.9);
                    graphics.fillCircle(k3[0] - 0.8, k3[1] - 0.8, 1.4);
                }
            }
        };

        // String + bolt (always topmost). Rest nock sits just behind the limb
        // tips; drawing hauls it back along the rail.
        const pull = tension * 22;
        const nockD = tipD - 4 - pull;
        const drawStringAndBolt = () => {
            const tipL = P(tipD, -tipW, H - 9.5);
            const tipR = P(tipD, tipW, H - 9.5);
            const nock = P(nockD, 0, H - 2);
            graphics.lineStyle(1.6, stringC, alpha * 0.95);
            graphics.lineBetween(tipL[0], tipL[1], nock[0], nock[1]);
            graphics.lineBetween(tipR[0], tipR[1], nock[0], nock[1]);

            if (boltLoaded) {
                // THE BOLT is the hero: a huge spear spanning the machine,
                // its head jutting proud past the rail — recognizable as a
                // giant-arrow-thrower from any distance.
                const head = Math.min(nockD + 36, railFront + 9);
                const tail = head - 46;
                const shaftW = 3.2;
                // Shaft with a lit top edge
                quad(graphics, [
                    P(tail, shaftW, H - 2.6), P(tail, -shaftW, H - 2.6),
                    P(head, -shaftW * 0.75, H - 2.6), P(head, shaftW * 0.75, H - 2.6)
                ], isL3 ? 0xb8860b : (isL2 ? 0x777782 : 0x8a6a48), alpha);
                quad(graphics, [
                    P(tail, -shaftW * 0.15, H - 3.6), P(tail, -shaftW * 0.8, H - 3.6),
                    P(head, -shaftW * 0.6, H - 3.6), P(head, -shaftW * 0.1, H - 3.6)
                ], isL3 ? 0xffd700 : (isL2 ? 0x9a9aa6 : 0xa8845e), alpha * 0.8);
                // Big leaf-shaped head
                const hp = P(head + 11, 0, H - 2.6);
                const hMid1 = P(head + 3.5, 5.4, H - 2.6);
                const hMid2 = P(head + 3.5, -5.4, H - 2.6);
                const hBase = P(head, 0, H - 2.6);
                quad(graphics, [hp, hMid1, hBase, hMid2], isL3 ? 0xffd700 : 0x3a3a3a, alpha);
                // Tall twin fletching at the tail
                const f1 = P(tail - 2, 0, H - 2.6);
                const f2 = P(tail + 13, 0, H - 2.6);
                const fUp = P(tail + 3, 0, H - 13);
                const fSide = P(tail + 3, 8.5, H + 0.5);
                const fc = isL3 ? 0xffd700 : (isL2 ? 0x555560 : 0xcc3333);
                quad(graphics, [f1, fUp, f2], fc, alpha);
                quad(graphics, [f1, fSide, f2], fc, alpha * 0.85);
            }
        };

        // Aim-aware assembly: whichever end of the machine faces up-screen is
        // drawn first so nearer parts correctly cover it.
        if (sin < 0) {
            drawPowerPlant();
            drawRail();
            drawWinch();
        } else {
            drawWinch();
            drawRail();
            drawPowerPlant();
        }
        drawStringAndBolt();

        // lastFireTime is stamped at the START of the 400 ms wind-up. Key the
        // flash to the actual release pose so it cannot precede the bolt.
        if (!boltLoaded && tension > 0.15 && time > 0) {
            const m = P(railFront + 2, 0, H - 2);
            graphics.fillStyle(0xffffcc, alpha * 0.85);
            graphics.fillCircle(m[0], m[1], 3);
        }
    }

    static drawXBow(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, time: number = 0, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        BuildingRenderer.renderXBowV2(1, graphics, c1, c2, c3, c4, center, alpha, tint, building, time, baseGraphics, skipBase, onlyBase);
    }

    static drawXBowLevel2(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, time: number = 0, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        BuildingRenderer.renderXBowV2(2, graphics, c1, c2, c3, c4, center, alpha, tint, building, time, baseGraphics, skipBase, onlyBase);
    }

    static drawXBowLevel3(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, time: number = 0, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        BuildingRenderer.renderXBowV2(3, graphics, c1, c2, c3, c4, center, alpha, tint, building, time, baseGraphics, skipBase, onlyBase);
    }

    /**
     * X-BOW — a rapid-fire magazine crossbow turret.
     *
     * A stout drum tower carries a compact repeating crossbow. Its energy is
     * mechanical: a bolt hopper feeds the rail from above and a side flywheel
     * visibly whirs while the weapon is cycling (it fires every ~220ms, so in
     * combat the whole head is alive). The shuttle string snaps back on every
     * shot via ballistaStringTension (1 = just fired, decays to 0).
     *
     * Story across levels: timber repeater (L1) -> iron autobow (L2) ->
     * gilded marble arbalest (L3).
     *
     * Idle (baked ambient loop, P = 1500ms): the 4-spoke cocking reels creep
     * at ~today's rate with an exact 90°-per-P pattern repeat, and a glint
     * chases the magazine bolt butts row by row once per P.
     */
    private static renderXBowV2(level: number, graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: any, time: number = 0, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        const g = baseGraphics || graphics;
        const isL2 = level >= 2;
        const isL3 = level >= 3;

        const angle = building?.ballistaAngle ?? 0;
        const tension = building?.ballistaStringTension ?? 0;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const H = -31; // weapon height above ground (drum top is at -17)

        const ax = (d: number) => cos * d;
        const ay = (d: number) => sin * 0.5 * d;
        const px = (w: number) => -sin * w;
        const py = (w: number) => cos * 0.5 * w;
        const P = (d: number, w: number, h: number) => [
            center.x + ax(d) + px(w),
            center.y + h + ay(d) + py(w)
        ];

        const quad = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number) => {
            gr.fillStyle(color, a);
            gr.beginPath();
            gr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
            gr.closePath();
            gr.fillPath();
        };

        // ===== PALETTE =====
        const drumWallLit = isL3 ? 0x7d5c3a : isL2 ? 0x4a4a56 : 0x6d5334;
        const drumWallDark = isL3 ? 0x5f4526 : isL2 ? 0x35353f : 0x53401f;
        const drumTopC = isL3 ? 0x8f6c46 : isL2 ? 0x5a5a66 : 0x7d6340;
        const drumDetail = isL3 ? 0xdaa520 : isL2 ? 0x23232b : 0x453317;
        const steelDark = isL3 ? 0x8a6508 : 0x26262e;
        const steelMid = isL3 ? 0xb8860b : 0x42424c;
        const steelLight = isL3 ? 0xffd700 : 0x6a6a76;
        const limbA = isL3 ? 0xe8e4d4 : 0x42424c;
        const limbB = isL3 ? 0xcfc9b8 : 0x26262e;
        const woodMid = 0x5d4037;
        const woodLight = 0x795548;
        const receiverMid = isL3 ? 0xc9992a : isL2 ? 0x3c3c46 : woodMid;
        const receiverLight = isL3 ? 0xe8c25a : isL2 ? 0x55555f : woodLight;
        const boltTipC = isL3 ? 0xffd700 : 0x9a9aa4;
        const stringC = isL3 ? 0xffe9a0 : 0xe8e0d0;

        // ===== FORTIFIED PAD =====
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.8, 0.78);
            BuildingRenderer.chamferPad(g, c1, c2, c3, c4, center, alpha, 0.6,
                isL3 ? 0xcfc5ae : isL2 ? 0x50505a : 0x8a7355,
                isL3 ? 0xafa58c : isL2 ? 0x33333c : 0x5f4d38,
                isL3 ? 0xdaa520 : null);
        }

        if (onlyBase) return;

        // ===== DRUM TOWER =====
        const drumR = 29;
        const drumRy = 15;
        const drumTopY = center.y - 17;
        // Ground contact shadow
        graphics.fillStyle(0x111111, alpha * 0.35);
        graphics.fillEllipse(center.x + 2, center.y + 2, drumR * 2 + 5, drumRy * 2 - 2);
        // Wall: lower ellipse + rectangle + shading on the sun-away half
        graphics.fillStyle(drumWallLit, alpha);
        graphics.fillEllipse(center.x, center.y, drumR * 2, drumRy * 2);
        graphics.fillRect(center.x - drumR, drumTopY, drumR * 2, center.y - drumTopY);
        // Sun-away (east) half of the wall
        graphics.fillStyle(drumWallDark, alpha);
        graphics.beginPath();
        graphics.moveTo(center.x + drumR * 0.12, drumTopY);
        graphics.lineTo(center.x + drumR, drumTopY);
        graphics.lineTo(center.x + drumR, center.y);
        graphics.lineTo(center.x + drumR * 0.12, center.y + drumRy);
        graphics.closePath();
        graphics.fillPath();

        // Bands drawn as front arcs so they hug the drum's curvature instead
        // of cutting straight across it.
        const drumHoop = (yc: number, color: number, widthPx: number) => {
            graphics.lineStyle(widthPx, color, alpha);
            let px0 = center.x - drumR;
            let py0 = yc;
            for (let i = 1; i <= 10; i++) {
                const t = (i / 10) * Math.PI;
                const px1 = center.x - Math.cos(t) * drumR;
                const py1 = yc + Math.sin(t) * drumRy * 0.5;
                graphics.lineBetween(px0, py0, px1, py1);
                px0 = px1;
                py0 = py1;
            }
        };
        if (isL2 && !isL3) {
            drumHoop(center.y - 6, drumDetail, 2.6);
            drumHoop(drumTopY + 3, drumDetail, 2.2);
            graphics.fillStyle(0x6a6a76, alpha * 0.9);
            for (let i = -2; i <= 2; i++) {
                graphics.fillCircle(center.x + i * (drumR * 0.42), center.y - 6 + Math.sin(Math.acos(Math.min(1, Math.abs(i * 0.42)))) * drumRy * 0.5, 1.3);
            }
        } else if (isL3) {
            drumHoop(center.y - 6, 0xdaa520, 2.6);
            graphics.lineStyle(1, 0x4a3520, alpha * 0.55);
            for (let i = -2; i <= 2; i++) {
                const sx = center.x + i * (drumR * 0.38);
                graphics.lineBetween(sx, drumTopY + 3, sx, center.y + drumRy * Math.sqrt(Math.max(0, 1 - Math.pow(i * 0.38, 2))) - 2);
            }
        } else {
            // Timber staves
            graphics.lineStyle(1, drumDetail, alpha * 0.55);
            for (let i = -3; i <= 3; i++) {
                const sx = center.x + i * (drumR * 0.26);
                graphics.lineBetween(sx, drumTopY + 2, sx, center.y + drumRy * Math.sqrt(Math.max(0, 1 - Math.pow(i * 0.27, 2))) - 1);
            }
        }

        // Drum top + rotating cap ring
        graphics.fillStyle(drumTopC, alpha);
        graphics.fillEllipse(center.x, drumTopY, drumR * 2, drumRy * 2);
        graphics.lineStyle(1.6, drumDetail, alpha * 0.7);
        graphics.strokeEllipse(center.x, drumTopY, drumR * 2, drumRy * 2);
        // Turntable cap: seams rotate with the aim
        graphics.fillStyle(isL3 ? 0x74553c : isL2 ? 0x47474f : 0x6b5334, alpha);
        graphics.fillEllipse(center.x, drumTopY - 1, 42, 21);
        graphics.lineStyle(1, drumDetail, alpha * 0.8);
        for (const t of [-0.55, 0, 0.55]) {
            graphics.lineBetween(
                center.x + ax(-17.5) + px(t * 17), drumTopY - 1 + ay(-17.5) + py(t * 17),
                center.x + ax(17.5) + px(t * 17), drumTopY - 1 + ay(17.5) + py(t * 17)
            );
        }
        graphics.lineStyle(2, isL3 ? 0xdaa520 : steelMid, alpha * 0.9);
        graphics.strokeEllipse(center.x, drumTopY - 1, 42, 21);

        // ===== WEAPON HEAD =====
        const sinceFire = building?.lastFireTime ? (time - building.lastFireTime) : Infinity;
        const cycling = sinceFire < 1500;

        // Pedestal from cap up to the receiver
        quad(graphics, [
            [center.x + 5, drumTopY - 1], [center.x - 5, drumTopY - 1],
            [center.x - 4, center.y + H + 6], [center.x + 4, center.y + H + 6]
        ], steelDark, alpha);

        const railBack = -18;
        const railFront = 27;

        const drawReceiver = () => {
            const w = 5.6;
            // Under-shade, body, lit top
            quad(graphics, [
                P(railBack, w, H + 2), P(railBack, -w, H + 2),
                P(railFront, -w, H + 2), P(railFront, w, H + 2)
            ], steelDark, alpha);
            quad(graphics, [
                P(railBack, w, H), P(railBack, -w, H),
                P(railFront, -w, H), P(railFront, w, H)
            ], receiverMid, alpha);
            quad(graphics, [
                P(railBack, -w * 0.5, H - 1.4), P(railBack, -w * 0.02, H - 1.4),
                P(railFront, -w * 0.02, H - 1.4), P(railFront, -w * 0.5, H - 1.4)
            ], receiverLight, alpha * 0.9);
            // Ejection groove
            graphics.lineStyle(1.1, steelDark, alpha * 0.9);
            graphics.lineBetween(P(railBack + 2, 0, H - 1)[0], P(railBack + 2, 0, H - 1)[1], P(railFront - 1, 0, H - 1)[0], P(railFront - 1, 0, H - 1)[1]);
            // Muzzle guide ring
            const mz = P(railFront, 0, H - 1);
            graphics.lineStyle(2, isL3 ? 0xdaa520 : steelMid, alpha);
            graphics.strokeEllipse(mz[0], mz[1], 6.6, 4.2);

            // Cocking crank-reels hugging the receiver's rear flanks: the
            // repeating mechanism, whirring while the weapon cycles and
            // creeping while it idles. They sit directly against the rail so
            // nothing floats free of the body. The reel is 4-fold symmetric
            // (4 identical spokes + knobs), and the idle rate advances the
            // crank exactly 90° per 1500ms — so the DRAWN pattern repeats
            // exactly every 1500ms (the bake's ambient-loop period) while
            // the perceived creep stays at today's ~time/1100 speed. The
            // fast time/90 combat re-cock whirl is untouched.
            const crank = cycling ? time / 90 : time * (Math.PI * 2) / 6000;
            for (const side of [-1, 1]) {
                const [ex, ey] = P(railBack + 2.5, side * 6, H + 1.2);
                graphics.fillStyle(steelDark, alpha);
                graphics.fillCircle(ex, ey, 3.2);
                graphics.fillStyle(steelMid, alpha);
                graphics.fillCircle(ex, ey, 2.2);
                graphics.lineStyle(1.8, steelDark, alpha);
                for (let sp = 0; sp < 4; sp++) {
                    const sa = crank + sp * (Math.PI / 2);
                    graphics.lineBetween(ex, ey, ex + Math.cos(sa) * 4.6, ey + Math.sin(sa) * 2.9);
                }
                graphics.fillStyle(isL3 ? 0xffd700 : steelLight, alpha);
                for (let sp = 0; sp < 4; sp++) {
                    const sa = crank + sp * (Math.PI / 2);
                    graphics.fillCircle(ex + Math.cos(sa) * 4.6, ey + Math.sin(sa) * 2.9, 1.4);
                }
            }
        };

        const drawLimbs = () => {
            // Stubby recurve prods with real thickness, like a compound bow's
            // limbs — thickness runs perpendicular to each blade on screen.
            const strip = (a: number[], b: number[], wa: number, wb: number, color: number) => {
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const len = Math.max(0.001, Math.hypot(dx, dy));
                const nx = -dy / len;
                const ny = dx / len;
                quad(graphics, [
                    [a[0] + nx * wa, a[1] + ny * wa],
                    [b[0] + nx * wb, b[1] + ny * wb],
                    [b[0] - nx * wb, b[1] - ny * wb],
                    [a[0] - nx * wa, a[1] - ny * wa]
                ], color, alpha);
            };
            for (const side of [-1, 1]) {
                const root = P(12, side * 5.5, H - 1);
                const mid = P(15.5, side * 13, H - 2.6);
                const tip = P(17.5, side * 20, H - 4);
                strip(root, mid, 4.2, 3, limbA);
                strip(mid, tip, 3, 1.8, limbB);
                graphics.fillStyle(isL3 ? 0xffd700 : steelLight, alpha);
                graphics.fillCircle(tip[0], tip[1], 2.4);
            }
        };

        const drawHopper = () => {
            // Magazine box perched over the rear of the receiver, tilted
            // toward the rail: top face shows the next bolts waiting.
            // Drawn as a real rotation-proof box: of its four side faces we
            // always render exactly the two whose outward normals point
            // down-screen, whatever the aim — no face can ever go missing.
            const b0 = railBack;
            const b1 = railBack + 13.5;
            const wT = 7.5;
            const hTop = H - 12.5;
            const hBot = H - 2;
            const sideLit = isL3 ? 0xc9992a : isL2 ? 0x3c3c46 : woodMid;
            const baseShade = isL3 ? 0xb8860b : isL2 ? 0x2b2b33 : 0x4d3527;

            // Cross faces (±wT): visible when their normal (±py) points down-screen
            const crossFace = (side: number, color: number) => quad(graphics, [
                P(b0, side * wT, hBot), P(b1, side * wT, hBot + 1.5),
                P(b1, side * wT, hTop + 1.5), P(b0, side * wT, hTop)
            ], color, alpha);
            // Along faces (front b1 / rear b0): visible when ±ay points down-screen
            const alongFace = (d: number, hUp: number, hDn: number, color: number) => quad(graphics, [
                P(d, wT, hDn), P(d, -wT, hDn),
                P(d, -wT, hUp), P(d, wT, hUp)
            ], color, alpha);

            if (cos >= 0) crossFace(1, sideLit); else crossFace(-1, sideLit);
            if (sin >= 0) alongFace(b1, hTop + 1.5, hBot + 1.5, baseShade);
            else alongFace(b0, hTop, hBot, baseShade);

            // Top face, tilted toward the front — always visible, always last
            quad(graphics, [
                P(b0, wT, hTop), P(b1, wT, hTop + 1.5),
                P(b1, -wT, hTop + 1.5), P(b0, -wT, hTop)
            ], isL3 ? 0xe8c25a : isL2 ? 0x4a4a54 : woodLight, alpha);
            if (isL3) {
                // Gold lid trim along the hopper's front edge
                const e1 = P(b1, wT, hTop + 1.5);
                const e2 = P(b1, -wT, hTop + 1.5);
                graphics.lineStyle(1.4, 0xdaa520, alpha * 0.95);
                graphics.lineBetween(e1[0], e1[1], e2[0], e2[1]);
            }
            // Bolt butts waiting in the magazine. A soft glint chases down
            // the rows toward the feed chute as the mechanism ticks over —
            // each row pulses once per 1500ms (exactly the ambient-loop
            // period), an opaque RGB overdraw (never an alpha shimmer), so
            // the idle reads at aims where the crank-reels hide behind the
            // hopper.
            const glintW = (Math.PI * 2) / 1500;
            for (let i = 0; i < 3; i++) {
                const d = b0 + 3.2 + i * 4.3;
                const s1 = P(d, 2.8, hTop + 0.4 + (d - b0) / (b1 - b0) * 1.8);
                const s2 = P(d, -2.8, hTop + 0.4 + (d - b0) / (b1 - b0) * 1.8);
                graphics.fillStyle(boltTipC, alpha);
                graphics.fillCircle(s1[0], s1[1], 1.45);
                graphics.fillCircle(s2[0], s2[1], 1.45);
                const gl = Math.pow(Math.max(0, Math.cos(time * glintW - i * (Math.PI * 2) / 3)), 3);
                if (gl > 0.04) {
                    graphics.fillStyle(0xffffff, alpha * 0.85 * gl);
                    graphics.fillCircle(s1[0], s1[1], 1.05);
                    graphics.fillCircle(s2[0], s2[1], 1.05);
                }
            }
            // Feed chute hint down to the rail
            graphics.lineStyle(1.4, steelDark, alpha * 0.8);
            graphics.lineBetween(P(b1 - 1, 0, hBot + 2)[0], P(b1 - 1, 0, hBot + 2)[1], P(b1 + 2, 0, H - 1.5)[0], P(b1 + 2, 0, H - 1.5)[1]);
        };


        // String + shuttle + loaded bolt (topmost)
        const drawStringAndBolt = () => {
            const pull = tension * 12;
            const nockD = 12 - pull;
            const tipL = P(17.5, -20, H - 4);
            const tipR = P(17.5, 20, H - 4);
            const nock = P(nockD, 0, H - 1.8);
            graphics.lineStyle(1.4, stringC, alpha * 0.95);
            graphics.lineBetween(tipL[0], tipL[1], nock[0], nock[1]);
            graphics.lineBetween(tipR[0], tipR[1], nock[0], nock[1]);
            // Shuttle block riding the groove
            graphics.fillStyle(steelLight, alpha);
            graphics.fillRect(nock[0] - 2.2, nock[1] - 2.2, 4.4, 4.4);

            if (tension < 0.35) {
                // Next bolt seated and ready — pale shaft so it reads on wood
                const tail = nockD + 1;
                const head = nockD + 15;
                quad(graphics, [
                    P(tail, 1.5, H - 2), P(tail, -1.5, H - 2),
                    P(head, -1.2, H - 2), P(head, 1.2, H - 2)
                ], isL3 ? 0xffd700 : 0xd8c49a, alpha);
                const hp = P(head + 4.4, 0, H - 2);
                quad(graphics, [hp, P(head, 2.3, H - 2), P(head, -2.3, H - 2)], boltTipC, alpha);
            }
        };

        // Muzzle flash for a single frame-ish window after each shot
        const drawFlash = () => {
            if (sinceFire < 120) {
                const m = P(railFront + 3, 0, H - 1.5);
                graphics.fillStyle(0xffee88, alpha * 0.9);
                quad(graphics, [
                    P(railFront + 1, 2, H - 1.5), P(railFront + 8, 0, H - 1.5),
                    P(railFront + 1, -2, H - 1.5)
                ], 0xffee88, alpha * 0.9);
                graphics.fillStyle(0xffffff, alpha * 0.9);
                graphics.fillCircle(m[0], m[1], 1.6);
            }
        };

        // Aim-aware layering: hopper sits at the rear of the head — when the
        // rear faces the viewer it must draw over the receiver, and under it
        // when it faces away.
        if (sin < 0) {
            drawHopper();
            drawReceiver();
            drawLimbs();
        } else {
            drawReceiver();
            drawLimbs();
            drawHopper();
        }
        drawStringAndBolt();
        drawFlash();
    }

    static drawMortar(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building: any, time: number, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        const level = Number(building?.level) || 1;
        const isLevel2 = level >= 2;
        const isLevel3 = level >= 3;
        const isLevel4 = level >= 4;
        const size = isLevel4 ? 1.25 : (isLevel3 ? 1.2 : (isLevel2 ? 1.12 : 1.0));
        const g = baseGraphics || graphics;

        // Recoil animation - reduced movement + scale shrink for perspective effect
        const timeSinceFire = building?.lastFireTime ? (time - building.lastFireTime) : 10000;
        const recoilDuration = 400;
        let recoil = 0;
        let recoilScale = 1.0;
        if (timeSinceFire < recoilDuration) {
            const t = timeSinceFire / recoilDuration;
            const recoilAmount = Math.sin(t * Math.PI);
            recoil = recoilAmount * 5;
            recoilScale = 1.0 - recoilAmount * 0.08;
        }

        // Subtle rotation - based on horizontal direction to target in screen space
        const aimAngle = building?.ballistaAngle ?? 0;
        const horizontalAim = Math.cos(aimAngle);

        // Snap to 7 discrete positions
        let rotationDeg = 0;
        if (horizontalAim > 0.9) rotationDeg = 30;
        else if (horizontalAim > 0.6) rotationDeg = 20;
        else if (horizontalAim > 0.25) rotationDeg = 10;
        else if (horizontalAim < -0.9) rotationDeg = -30;
        else if (horizontalAim < -0.6) rotationDeg = -20;
        else if (horizontalAim < -0.25) rotationDeg = -10;

        // Colors - varies by level
        const ironColor = isLevel4 ? 0xdaa520 : (isLevel3 ? 0x4a4a4a : (isLevel2 ? 0x3a3a3a : 0x4a4a4a));
        const ironDark = isLevel4 ? 0xb8860b : (isLevel3 ? 0x3a3a3a : (isLevel2 ? 0x2a2a2a : 0x3a3a3a));
        const ironLight = isLevel4 ? 0xffd700 : (isLevel3 ? 0x6a6a6a : (isLevel2 ? 0x4a4a4a : 0x5a5a5a));
        const ironHighlight = isLevel4 ? 0xffd700 : (isLevel3 ? 0xcccccc : null); // Gold highlight for L4, silver for L3
        const dirtColor = isLevel4 ? 0xccccbb : (isLevel3 ? 0x4a4038 : 0x3a3020);

        // Emplacement dimensions
        const pitRadius = 22 * size;
        const pitY = center.y + 2;

        // ============================================
        // STONE BASE PLATFORM
        // ============================================

        // Clash-style grounding: soft shadow + a compact emplacement pad
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.85, 0.78);
            BuildingRenderer.chamferPad(g, c1, c2, c3, c4, center, alpha, 0.68,
                isLevel4 ? 0xcfc5ae : isLevel3 ? 0x4a4540 : 0x6a655d,
                isLevel4 ? 0xafa58c : isLevel3 ? 0x33302b : 0x4b463f,
                isLevel4 ? 0xdaa520 : null);

            if (isLevel3) {
                // Small decorative stones near emplacement
                g.fillStyle(isLevel4 ? 0xddddcc : 0x5a5a5a, alpha * 0.7);
                g.fillCircle(center.x - 22, center.y - 8, 2.5);
                g.fillCircle(center.x + 20, center.y - 6, 2);
                g.fillCircle(center.x - 18, center.y + 10, 2);
                g.fillCircle(center.x + 22, center.y + 8, 2.5);
            }
        }
        if (onlyBase) return;

        // ============================================
        // DIRT EMPLACEMENT (the pit the mortar sits in)
        // ============================================
        // Outer dirt ring
        graphics.fillStyle(dirtColor, alpha);
        graphics.fillEllipse(center.x, pitY, pitRadius * 2.2, pitRadius * 1.0);

        // Inner dark pit
        graphics.fillStyle(0x1a1510, alpha);
        graphics.fillEllipse(center.x, pitY + 2, pitRadius * 1.8, pitRadius * 0.8);

        // Deep shadow
        graphics.fillStyle(0x0a0a08, alpha);
        graphics.fillEllipse(center.x, pitY + 4, pitRadius * 1.4, pitRadius * 0.6);

        // ============================================
        // MORTAR BARREL (recoils into pit with scale shrink + ROTATION)
        // Rotation is achieved by offsetting top more than bottom
        // ============================================
        const barrelY = center.y - 8 * size + recoil;
        const barrelWidth = 20 * size * recoilScale;

        // Tilt multiplier - how much each vertical level gets offset
        // Bottom = 0 (stays centered), Top = full rotation offset
        const tiltAmount = rotationDeg * 0.12; // Max ~3.6px at ±30 degrees

        // Barrel base (bottom, goes into pit) - minimal tilt
        graphics.fillStyle(ironDark, alpha);
        graphics.fillEllipse(center.x + tiltAmount * 0.1, barrelY + 14 * size * recoilScale, barrelWidth * 0.8, barrelWidth * 0.35);
        graphics.fillEllipse(center.x + tiltAmount * 0.2, barrelY + 10 * size * recoilScale, barrelWidth * 0.9, barrelWidth * 0.4);

        // Main barrel body - progressive tilt
        graphics.fillStyle(ironColor, alpha);
        graphics.fillEllipse(center.x + tiltAmount * 0.35, barrelY + 6 * size * recoilScale, barrelWidth, barrelWidth * 0.45);
        graphics.fillEllipse(center.x + tiltAmount * 0.5, barrelY + 2 * size * recoilScale, barrelWidth * 1.1, barrelWidth * 0.5);
        graphics.fillEllipse(center.x + tiltAmount * 0.65, barrelY - 2 * size * recoilScale, barrelWidth * 1.2, barrelWidth * 0.55);

        // Iron bands - also tilt
        graphics.lineStyle(2, ironDark, alpha);
        graphics.strokeEllipse(center.x + tiltAmount * 0.25, barrelY + 8 * size * recoilScale, barrelWidth * 0.85, barrelWidth * 0.38);
        graphics.strokeEllipse(center.x + tiltAmount * 0.5, barrelY, barrelWidth * 1.1, barrelWidth * 0.5);

        // Level 2-3: Extra reinforcement band (skip at L4 — overlaps wrong with gold barrel)
        if (isLevel2 && !isLevel4) {
            graphics.lineStyle(2, 0x2a2a2a, alpha);
            graphics.strokeEllipse(center.x + tiltAmount * 0.4, barrelY + 4 * size * recoilScale, barrelWidth * 0.95, barrelWidth * 0.43);
        }

        // Barrel rim (top) - maximum tilt
        graphics.fillStyle(ironLight, alpha);
        graphics.fillEllipse(center.x + tiltAmount * 0.85, barrelY - 6 * size * recoilScale, barrelWidth * 1.3, barrelWidth * 0.6);

        // Level 3: Single beefy shiny rim highlight
        if (ironHighlight) {
            graphics.lineStyle(3, ironHighlight, alpha * 0.85);
            graphics.strokeEllipse(center.x + tiltAmount * 0.85, barrelY - 7 * size * recoilScale, barrelWidth * 1.38, barrelWidth * 0.64);
        }

        // Inner rim
        graphics.fillStyle(ironColor, alpha);
        graphics.fillEllipse(center.x + tiltAmount * 0.85, barrelY - 6 * size * recoilScale, barrelWidth * 1.1, barrelWidth * 0.5);

        // Bore hole
        graphics.fillStyle(0x0a0a0a, alpha);
        graphics.fillEllipse(center.x + tiltAmount * 0.9, barrelY - 6 * size * recoilScale, barrelWidth * 0.85, barrelWidth * 0.38);

        // Bore depth
        graphics.fillStyle(0x000000, alpha * 0.8);
        graphics.fillEllipse(center.x + tiltAmount * 1.0, barrelY - 4 * size * recoilScale, barrelWidth * 0.7, barrelWidth * 0.32);

        // ============================================
        // FRONT DIRT EDGE (covers barrel bottom - the masking layer)
        // ============================================
        graphics.fillStyle(dirtColor, alpha);
        graphics.beginPath();
        // Draw front arc of the dirt emplacement
        for (let i = 0; i <= 16; i++) {
            const angle = (i / 32) * Math.PI * 2;
            const px = center.x + Math.cos(angle) * pitRadius * 1.1;
            const py = pitY + Math.sin(angle) * pitRadius * 0.5;
            if (i === 0) graphics.moveTo(px, py);
            else graphics.lineTo(px, py);
        }
        // Inner edge
        for (let i = 16; i >= 0; i--) {
            const angle = (i / 32) * Math.PI * 2;
            const px = center.x + Math.cos(angle) * pitRadius * 0.7;
            const py = pitY + Math.sin(angle) * pitRadius * 0.32;
            graphics.lineTo(px, py);
        }
        graphics.closePath();
        graphics.fillPath();

        // Dirt texture on front edge
        graphics.fillStyle(0x2a2518, alpha * 0.5);
        graphics.fillCircle(center.x + 8, pitY + pitRadius * 0.35, 3);
        graphics.fillCircle(center.x - 6, pitY + pitRadius * 0.4, 2);
        graphics.fillCircle(center.x + 2, pitY + pitRadius * 0.38, 2.5);

        // ============================================
        // SMOKE EFFECT ON FIRING
        // ============================================
        if (BuildingRenderer.AMBIENT_VAPOR && timeSinceFire < 300) {
            const t = timeSinceFire / 300;
            const smokeAlpha = (1 - t) * 0.5;
            graphics.fillStyle(0x888888, alpha * smokeAlpha);
            graphics.fillCircle(center.x + Math.sin(time / 40) * 4, barrelY - 12 - t * 20, 4 + t * 6);
            graphics.fillCircle(center.x - 4 + Math.cos(time / 50) * 3, barrelY - 18 - t * 25, 3 + t * 5);
            graphics.fillCircle(center.x + 3 + Math.sin(time / 60) * 2, barrelY - 24 - t * 28, 2.5 + t * 4);
        }
    }

    static drawTeslaCoil(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building: any, time: number, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
        const level = Number(building?.level) || 1;
        const isLevel2 = level >= 2;
        const isLevel3 = level >= 3;
        const g = baseGraphics || graphics;

        // Determine tesla state from building properties
        const isCharging = building?.teslaCharging === true;
        const chargeStart = building?.teslaChargeStart ?? 0;
        const isCharged = building?.teslaCharged === true;
        const lastFireTime = building?.lastFireTime ?? 0;
        const chargeDuration = 800;
        const chargeProgress = isCharging ? Math.min((time - chargeStart) / chargeDuration, 1) : 0;

        // Cooldown: after firing, sink back over 600ms
        const timeSinceFire = time - lastFireTime;
        const isCoolingDown = !isCharging && !isCharged && lastFireTime > 0 && timeSinceFire < 600;
        const cooldownProgress = isCoolingDown ? timeSinceFire / 600 : 0;

        const hasEverFired = lastFireTime > 0;
        const isActive = isCharging || isCharged || isCoolingDown;

        // Calculate yOffset for subtle dip when idle
        const dipAmount = 5; // Subtle dip, not fully underground
        let yOffset: number;
        if (isCharging) {
            // Rise from dip to 0 over charge duration
            yOffset = dipAmount * (1 - chargeProgress);
        } else if (isCharged) {
            // Fully extended
            yOffset = 0;
        } else if (isCoolingDown) {
            // Settle back down
            yOffset = dipAmount * cooldownProgress;
        } else {
            // Idle: subtle dip
            yOffset = dipAmount;
        }

        // Clash-style grounding: soft shadow + a compact pad
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.8, 0.75);
            BuildingRenderer.chamferPad(g, c1, c2, c3, c4, center, alpha, 0.66,
                isLevel3 ? 0xcfc5ae : isLevel2 ? 0x6a6a6a : 0x5a5a5a,
                isLevel3 ? 0xafa58c : isLevel2 ? 0x4a4a4a : 0x3f3f3f,
                isLevel3 ? 0xdaa520 : null);

            // L2+: Raised platform edge
            if (isLevel2) {
                g.fillStyle(isLevel3 ? 0xddddcc : 0x555555, alpha * 0.8);
                g.fillRect(center.x - 16, center.y + 2, 32, 4);
            }
        }
        if (onlyBase) return;

        // Support post (shifted by yOffset)
        const postWidth = isLevel3 ? 10 : (isLevel2 ? 10 : 8);
        graphics.fillStyle(isLevel3 ? 0xddddcc : (isLevel2 ? 0x5a4a3a : 0x4a3a2a), alpha);
        graphics.fillRect(center.x - postWidth / 2, center.y - 35 + yOffset, postWidth, 35);
        graphics.lineStyle(1, isLevel3 ? 0xdaa520 : 0x2a1a0a, 0.5 * alpha);
        graphics.strokeRect(center.x - postWidth / 2, center.y - 35 + yOffset, postWidth, 35);

        // Coil rings (shifted by yOffset)
        const ringCount = isLevel3 ? 5 : (isLevel2 ? 4 : 3);
        for (let i = 0; i < ringCount; i++) {
            const ringY = center.y - 10 - i * (isLevel2 ? 7 : 8) + yOffset;
            const ringSize = isLevel3 ? 15 : (isLevel2 ? 14 : 12);

            const ringFill = isLevel3 ? 0xdaa520 : 0x7a7a7a;
            const ringStroke = isLevel3 ? 0xb8860b : 0x3a3a3a;
            const ringDull = isLevel3 ? 0xddddcc : 0x5a5a5a;
            const ringUnlit = isLevel3 ? 0xccccbb : 0x4a4a4a;

            if (isActive) {
                const ringThreshold = i / ringCount;
                const isLit = chargeProgress > ringThreshold || isCharged || isCoolingDown;

                if (isLit) {
                    graphics.fillStyle(ringFill, alpha);
                    graphics.fillEllipse(center.x, ringY, ringSize, 4);
                    graphics.lineStyle(1, ringStroke, alpha);
                    graphics.strokeEllipse(center.x, ringY, ringSize, 4);
                    const glowAlpha = isCharged ? 0.6 : (0.3 + (chargeProgress - ringThreshold) * 0.4);
                    graphics.lineStyle(isLevel2 ? 2 : 1, 0x00ccff, alpha * glowAlpha);
                    graphics.strokeEllipse(center.x, ringY, ringSize + 1, 5);
                } else {
                    graphics.fillStyle(ringUnlit, alpha);
                    graphics.fillEllipse(center.x, ringY, ringSize, 4);
                    graphics.lineStyle(1, ringStroke, alpha);
                    graphics.strokeEllipse(center.x, ringY, ringSize, 4);
                }
            } else if (!hasEverFired) {
                graphics.fillStyle(ringFill, alpha);
                graphics.fillEllipse(center.x, ringY, ringSize, 4);
                graphics.lineStyle(1, ringStroke, alpha);
                graphics.strokeEllipse(center.x, ringY, ringSize, 4);
                graphics.lineStyle(isLevel2 ? 2 : 1, 0x00ccff, alpha * 0.45);
                graphics.strokeEllipse(center.x, ringY, ringSize + 1, 5);
            } else {
                graphics.fillStyle(ringDull, alpha);
                graphics.fillEllipse(center.x, ringY, ringSize, 4);
                graphics.lineStyle(1, ringStroke, alpha);
                graphics.strokeEllipse(center.x, ringY, ringSize, 4);
            }
        }

        // L2: Electrical ring around base — only visible when active
        if (isLevel2 && isActive) {
            const ringPulse = 0.5 + Math.sin(time / 100) * 0.3;
            graphics.lineStyle(3, 0x00ccff, alpha * ringPulse * 0.6);
            graphics.strokeEllipse(center.x, center.y - 2, 24, 8);
            graphics.lineStyle(1, 0x88ffff, alpha * ringPulse * 0.8);
            graphics.strokeEllipse(center.x, center.y - 2, 22, 7);

            // Occasional sparks from ring
            const sparkSeed = Math.floor(time / 80);
            if (sparkSeed % 3 === 0) {
                const sparkAngle = (time / 50) % (Math.PI * 2);
                const sx = center.x + Math.cos(sparkAngle) * 12;
                const sy = center.y - 2 + Math.sin(sparkAngle) * 4;
                graphics.fillStyle(0xffffff, alpha * 0.8);
                graphics.fillCircle(sx, sy, 2);
            }
        }

        // Glowing electric orb (shifted by yOffset)
        const orbY = center.y - 40 + yOffset;

        if (isCharged || (isCharging && chargeProgress >= 1)) {
            // Fully charged / firing: bright pulsing cyan orb
            const pulseIntensity = 0.8 + Math.sin(time / 120) * 0.2;

            // Outer glow (pulsing)
            graphics.fillStyle(0x00ccff, 0.3 * alpha * pulseIntensity);
            graphics.fillCircle(center.x, orbY, 14 + Math.sin(time / 80) * 2);

            // Mid glow
            graphics.fillStyle(0x44ddff, 0.5 * alpha * pulseIntensity);
            graphics.fillCircle(center.x, orbY, 10);

            // Core
            graphics.fillStyle(tint ?? 0xaaeeff, alpha);
            graphics.fillCircle(center.x, orbY, 7);

            // Electric highlight
            graphics.fillStyle(0xffffff, 0.8 * alpha);
            graphics.fillCircle(center.x - 2, orbY - 2, 2);
        } else if (isCharging) {
            // Charging: orb starts dull, brightens as charge completes
            const brightness = chargeProgress * 0.5;

            // Dim glow grows with charge
            if (chargeProgress > 0.7) {
                graphics.fillStyle(0x00ccff, 0.15 * alpha * chargeProgress);
                graphics.fillCircle(center.x, orbY, 10 + chargeProgress * 4);
            }

            // Orb transitions from dull to bright
            const orbColor = chargeProgress > 0.8 ? 0x66aacc : 0x556677;
            graphics.fillStyle(orbColor, alpha);
            graphics.fillCircle(center.x, orbY, 7);

            // Dim highlight
            graphics.fillStyle(0xaaaaaa, 0.3 * alpha * brightness);
            graphics.fillCircle(center.x - 2, orbY - 2, 2);
        } else {
            // Idle: dull gray-blue orb, no glow
            graphics.fillStyle(0x556677, alpha);
            graphics.fillCircle(center.x, orbY, 7);

            // Subtle dull highlight
            graphics.fillStyle(0x778899, 0.3 * alpha);
            graphics.fillCircle(center.x - 2, orbY - 2, 1.5);

            // Occasional idle crackle — small dim arcs to feel alive. The
            // old golden-angle sequence (idleSeed * 2.618) never repeated, so
            // the baked ambient loop could not close; now the whole pattern
            // is a closed 3000 ms cycle (250 ms-multiple, probe-measurable):
            // three crackle windows per loop, each at its own fixed angle,
            // with jitter terms on exact harmonics (k=16, k=14).
            const IDLE_P = 3000;
            const iw = (Math.PI * 2) / IDLE_P;
            const slot = Math.floor(((time % IDLE_P) + IDLE_P) % IDLE_P / 250); // 0..11
            const arcIdx = slot === 0 ? 0 : slot === 5 ? 1 : slot === 9 ? 2 : -1;
            if (arcIdx >= 0) {
                const arcAngle = 0.7 + arcIdx * 2.3;
                const arcLen = 8 + arcIdx * 2;
                const sx = center.x + Math.cos(arcAngle) * 5;
                const sy = orbY + Math.sin(arcAngle) * 5;
                const ex = center.x + Math.cos(arcAngle) * arcLen + Math.sin(time * iw * 16) * 2;
                const ey = orbY + Math.sin(arcAngle) * arcLen + Math.cos(time * iw * 14) * 1.5;

                graphics.lineStyle(1, 0x6699aa, alpha * 0.4);
                graphics.beginPath();
                graphics.moveTo(sx, sy);
                graphics.lineTo(ex, ey);
                graphics.strokePath();

                graphics.fillStyle(0x88aacc, alpha * 0.3);
                graphics.fillCircle(ex, ey, 1);
            }
        }
    }

    /**
     * PRISM TOWER — the Suspended Prism.
     *
     * No tower at all: leaning obsidian pylons hold a levitating crystal in a
     * cage of light. The crystal bobs and spins, energy tethers flicker from
     * the pylon tips, and higher levels add pylons, halos and orbiting motes.
     * The crystal's tip sits at y ≈ -55, exactly where MainScene starts the
     * beam.
     *
     * Levels: twin pylons + cyan shard (L1) -> three pylons + violet prism
     * (L2) -> arcane halo + magenta prism (L3) -> four gold-capped pylons,
     * double halo and radiant prism (L4).
     */
    static drawPrismTower(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, _tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        const g = baseGraphics || graphics;
        const level = Number(building?.level) || 1;
        const isL2 = level >= 2;
        const isL3 = level >= 3;
        const isL4 = level >= 4;

        const quad = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number) => {
            gr.fillStyle(color, a);
            gr.beginPath();
            gr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
            gr.closePath();
            gr.fillPath();
        };

        // ===== PALETTE =====
        const glow = isL4 ? 0xffe9a0 : isL3 ? 0xff5ce1 : isL2 ? 0xb37cff : 0x6ee8ff;
        const glowDeep = isL4 ? 0xdaa520 : isL3 ? 0xc02fa8 : isL2 ? 0x7e4fd0 : 0x2fa8c8;
        const stoneLit = isL4 ? 0xdcd3ba : 0x3c3c4a;
        const stoneDark = isL4 ? 0xb3a98d : 0x26262f;
        const trim = isL4 ? 0xffd700 : isL3 ? 0xd8d8e4 : glowDeep;

        // ===== ARCANE PAD =====
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.5, 0.7);
            BuildingRenderer.chamferPad(g, c1, c2, c3, c4, center, alpha, 0.56,
                isL4 ? 0xa89f8a : 0x2e2e38,
                isL4 ? 0x8a8272 : 0x1c1c24,
                isL4 ? 0xdaa520 : null);
        }

        if (onlyBase) return;

        // ===== IDLE LOOP TIME BASE (exact 3000 ms period) =====
        // Every idle term below is an integer harmonic of wIdle (the halo
        // wobble uses wIdle/2 inside an abs(), which still repeats at
        // exactly 3000 ms), so the baked ambient loop closes seamlessly at
        // 12 fps. The old free rates (time/420, /640, /300, /160, ...)
        // never co-repeated, so the probe flagged the prism non-periodic
        // and the bake seamed every 2 s.
        const wIdle = (Math.PI * 2) / 3000;

        // Arcane ring on the pad — ANIMATED, so it draws in the elevated
        // pass (the base layer bakes once and would freeze the pulse at an
        // arbitrary phase). The body pass paints it before everything else,
        // so it still reads as ground decal under the pylons/crystal.
        const ringPulse = 0.35 + Math.sin(time * wIdle) * 0.15;
        graphics.lineStyle(1.8, glow, alpha * ringPulse);
        graphics.strokeEllipse(center.x, center.y, 34, 17);
        graphics.lineStyle(1, glowDeep, alpha * ringPulse * 0.8);
        graphics.strokeEllipse(center.x, center.y, 24, 12);

        // ===== CRYSTAL STATE =====
        const bob = Math.sin(time * wIdle) * 2.4;
        const crystalY = center.y - 46 - bob;
        const halfH = isL4 ? 11 : isL3 ? 10 : isL2 ? 9 : 8;
        // Fake spin: the silhouette breathes as the prism rotates
        const spinPhase = Math.cos(time * wIdle);
        const halfW = (isL4 ? 8 : isL3 ? 7 : isL2 ? 6 : 5) * (0.6 + 0.4 * Math.abs(spinPhase));

        // Floating shadow: tightens when the crystal rises (soft on marble)
        graphics.fillStyle(0x000000, alpha * (isL4 ? 0.16 : 0.28) * (1 - bob / 10));
        graphics.fillEllipse(center.x, center.y + 1, 16 + bob, 7 + bob * 0.4);

        // ===== PYLONS (leaning obsidian monoliths) =====
        // Base angles walk around the pad; count grows with level.
        const pylonAngles = isL4
            ? [Math.PI * 0.28, Math.PI * 0.78, Math.PI * 1.28, Math.PI * 1.78]
            : isL2
                ? [Math.PI * 0.5, Math.PI * 1.1, Math.PI * 1.85]
                : [Math.PI * 0.85, Math.PI * 1.95];
        const tipH = 30;
        type Pylon = { bx: number; by: number; tx: number; ty: number; depth: number };
        const pylons: Pylon[] = pylonAngles.map(a2 => {
            const bx = center.x + Math.cos(a2) * 22;
            const by = center.y + Math.sin(a2) * 11;
            const tx = center.x + Math.cos(a2) * 7;
            const ty = center.y + Math.sin(a2) * 3.5 - tipH;
            return { bx, by, tx, ty, depth: by };
        });
        pylons.sort((a, b) => a.depth - b.depth); // far pylons first

        const drawPylon = (p: Pylon) => {
            const wBase = 4.6;
            const wTip = 2.2;
            // Two faces for a chiselled monolith: lit west, dark east
            quad(graphics, [
                [p.bx - wBase, p.by - 1], [p.bx, p.by + wBase * 0.55],
                [p.tx, p.ty + wTip * 0.5], [p.tx - wTip, p.ty - 0.5]
            ], stoneLit, alpha);
            quad(graphics, [
                [p.bx, p.by + wBase * 0.55], [p.bx + wBase, p.by - 1],
                [p.tx + wTip, p.ty - 0.5], [p.tx, p.ty + wTip * 0.5]
            ], stoneDark, alpha);
            // Rune seam glowing up the lit face
            const runePulse = 0.5 + Math.sin(time * wIdle * 2 + p.bx) * 0.3;
            graphics.lineStyle(1.2, isL4 ? 0xdaa520 : glow, alpha * runePulse);
            graphics.lineBetween(p.bx - wBase * 0.4, p.by - 1, p.tx - wTip * 0.4, p.ty + 0.5);
            // Tip cap
            graphics.fillStyle(trim, alpha);
            quad(graphics, [
                [p.tx - wTip - 0.6, p.ty - 0.5], [p.tx + wTip + 0.6, p.ty - 0.5],
                [p.tx, p.ty - 4.6]
            ], trim, alpha);
        };

        const drawTethers = () => {
            for (let i = 0; i < pylons.length; i++) {
                const p = pylons[i];
                const flicker = 0.4 + Math.sin(time * wIdle * 3 + i * 2.1) * 0.25;
                graphics.lineStyle(1.2, glow, alpha * flicker);
                graphics.lineBetween(p.tx, p.ty - 3, center.x, crystalY + halfH * 0.4);
            }
        };

        // While the beam fires, the ground ring feeds the crystal: the circle
        // flares and motes of light spiral up out of it into the prism.
        const firing = building?.lastFireTime ? time - building.lastFireTime < 260 : false;
        const drawGroundSurge = () => {
            if (!firing) return;
            // Flared ring + soft pool of light in the circle
            graphics.fillStyle(glow, alpha * 0.14);
            graphics.fillEllipse(center.x, center.y, 30, 15);
            graphics.lineStyle(2.2, glow, alpha * 0.85);
            graphics.strokeEllipse(center.x, center.y, 34, 17);
            // Faint column the motes travel inside
            quad(graphics, [
                [center.x - 7, center.y - 1],
                [center.x + 7, center.y - 1],
                [center.x + 2.5, crystalY + halfH * 0.5],
                [center.x - 2.5, crystalY + halfH * 0.5]
            ], glow, alpha * 0.07);
            // Spiralling motes, ground -> crystal
            const climb = center.y - (crystalY + halfH * 0.4);
            for (let i = 0; i < 5; i++) {
                const t = ((time / 620) + i / 5) % 1;
                const swirl = time / 480 + i * 2.51;
                const rad = 15 * (1 - t) + 2.5;
                const mx = center.x + Math.cos(swirl) * rad;
                const my = center.y - t * climb + Math.sin(swirl) * rad * 0.45;
                const fade = Math.sin(t * Math.PI); // ease in and out
                graphics.lineStyle(1.4, glow, alpha * fade * 0.85);
                graphics.lineBetween(mx, my + 3, mx, my - 2);
                graphics.fillStyle(0xffffff, alpha * fade * 0.9);
                graphics.fillCircle(mx, my - 2.5, 1.1);
            }
        };

        const drawCrystal = () => {
            // Soft aura
            const aura = 0.14 + Math.sin(time * wIdle * 2) * 0.05;
            graphics.fillStyle(glow, alpha * aura);
            graphics.fillCircle(center.x, crystalY, halfH + 7);

            // Bipyramid: left facet darker, right facet lighter; the split
            // line flips with the spin phase for a turning feel.
            const flip = spinPhase >= 0 ? 1 : -1;
            const top: number[] = [center.x, crystalY - halfH];
            const bot: number[] = [center.x, crystalY + halfH];
            const left: number[] = [center.x - halfW, crystalY - halfH * 0.08];
            const right: number[] = [center.x + halfW, crystalY - halfH * 0.08];
            quad(graphics, [top, left, bot], flip > 0 ? glowDeep : glow, alpha * 0.95);
            quad(graphics, [top, right, bot], flip > 0 ? glow : glowDeep, alpha * 0.95);
            // Inner fire
            quad(graphics, [
                [center.x, crystalY - halfH * 0.55],
                [center.x - halfW * 0.4, crystalY],
                [center.x, crystalY + halfH * 0.55],
                [center.x + halfW * 0.4, crystalY]
            ], 0xffffff, alpha * 0.75);
            // Glint at the beam tip
            const glint = 0.5 + Math.sin(time * wIdle * 3) * 0.35;
            graphics.fillStyle(0xffffff, alpha * glint);
            graphics.fillCircle(center.x, crystalY - halfH, 1.7);
        };

        const drawHalos = () => {
            if (!isL3) return;
            // abs() halves the sin's period, so wIdle/2 repeats at exactly P.
            const wob = Math.abs(Math.sin(time * wIdle / 2));
            graphics.lineStyle(1.4, trim, alpha * 0.8);
            graphics.strokeEllipse(center.x, crystalY, halfH * 2.4, 3.5 + wob * 4);
            if (isL4) {
                graphics.lineStyle(1, 0xffd700, alpha * 0.65);
                graphics.strokeEllipse(center.x, crystalY, halfH * 3.1, 5.5 + (1 - wob) * 4);
                // Orbiting motes
                for (let i = 0; i < 3; i++) {
                    const a2 = time * wIdle + (i * Math.PI * 2) / 3;
                    graphics.fillStyle(0xffe9a0, alpha * 0.95);
                    graphics.fillCircle(
                        center.x + Math.cos(a2) * halfH * 1.7,
                        crystalY + Math.sin(a2) * halfH * 0.55,
                        1.6
                    );
                }
            }
        };

        // Far pylons -> ground surge -> tethers -> crystal -> near pylons, so
        // the light cage wraps around the floating prism correctly.
        const far = pylons.filter(p => p.depth <= center.y);
        const near = pylons.filter(p => p.depth > center.y);
        far.forEach(drawPylon);
        drawGroundSurge();
        drawTethers();
        drawCrystal();
        drawHalos();
        near.forEach(drawPylon);
    }
    static drawArmyCamp(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, baseGraphics ?: Phaser.GameObjects.Graphics, building ?: any, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
    const g = baseGraphics || graphics; // Ground-plane elements render here.
    const level = Number(building?.level) || 1;
    const isLevel4 = level >= 4;
    const showWeaponRack = level >= 2;
    const showDummy = level >= 3;

    // === TRAINING GROUND BASE ===
    if (!skipBase) {
        // Chamfered-square training ground, inset a touch from the footprint
        // (no ground shadow — the patch itself grounds the camp)
        const inset = (a: Phaser.Math.Vector2) => new Phaser.Math.Vector2(
            center.x + (a.x - center.x) * 0.92,
            center.y + (a.y - center.y) * 0.92
        );
        const k1 = inset(c1);
        const k2 = inset(c2);
        const k3 = inset(c3);
        const k4 = inset(c4);
        const cut = 0.16;
        const kcorners = [k1, k2, k3, k4];
        const dirtOcto: Phaser.Math.Vector2[] = [];
        for (let i = 0; i < 4; i++) {
            const a2 = kcorners[i];
            const b2 = kcorners[(i + 1) % 4];
            dirtOcto.push(new Phaser.Math.Vector2(a2.x + (b2.x - a2.x) * cut, a2.y + (b2.y - a2.y) * cut));
            dirtOcto.push(new Phaser.Math.Vector2(a2.x + (b2.x - a2.x) * (1 - cut), a2.y + (b2.y - a2.y) * (1 - cut)));
        }
        g.fillStyle(tint ?? 0xb8a080, alpha);
        g.fillPoints(dirtOcto, true);
        g.lineStyle(1.4, 0x9a8060, alpha * 0.6);
        g.strokePoints(dirtOcto, true, true);
        g.lineStyle(2, 0xa89070, 0.5 * alpha);
        g.strokeEllipse(center.x, center.y, 45, 22.5);
        g.fillStyle(0xa89070, 0.3 * alpha);
        g.fillEllipse(center.x, center.y, 45, 22.5);
        g.fillStyle(0x9a8060, alpha * 0.5);
        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            const dist = 20 + (i % 3) * 12;
            const ox = Math.cos(angle) * dist * 0.8;
            const oy = Math.sin(angle) * dist * 0.4;
            g.fillCircle(center.x + ox, center.y + 5 + oy, 2 + (i % 2));
        }
        }

    if (!onlyBase) {
        // === CENTRAL CAMPFIRE ===
        const fireX = center.x;
        const fireY = center.y + 8;

        // Fire pit stones (ring) — marble at L4
        graphics.fillStyle(isLevel4 ? 0xccccbb : 0x555555, alpha);
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2;
            const stoneX = fireX + Math.cos(angle) * 12;
            const stoneY = fireY + Math.sin(angle) * 6;
            graphics.fillEllipse(stoneX, stoneY, 5, 3);
        }

        // Fire pit inner (ash/coals)
        graphics.fillStyle(0x2a2020, alpha);
        graphics.fillEllipse(fireX, fireY, 10, 5);

        // ===== IDLE LOOP TIME BASE (exact 1500 ms period) =====
        // Every flame/coal/spark term below is an integer harmonic of wIdle
        // so the baked ambient loop closes seamlessly.
        const wIdle = (Math.PI * 2) / 1500;

        // Glowing coals
        const coalGlow = 0.5 + Math.sin(time * wIdle) * 0.2;
        graphics.fillStyle(0x881100, alpha * coalGlow);
        graphics.fillEllipse(fireX, fireY, 8, 4);
        graphics.fillStyle(0xcc3300, alpha * coalGlow * 0.7);
        graphics.fillEllipse(fireX - 2, fireY, 4, 2);
        graphics.fillEllipse(fireX + 3, fireY + 1, 3, 1.5);

        // Main flame animation (375/300/500 ms — harmonics 4/5/3 of the loop)
        const flame1 = Math.sin(time * wIdle * 4) * 0.3 + 0.7;
        const flame2 = Math.sin(time * wIdle * 5 + 1) * 0.25 + 0.75;
        const flame3 = Math.sin(time * wIdle * 3 + 2) * 0.35 + 0.65;

        // Flame glow on ground — animated, so it must live on the ELEVATED
        // layer (the base layer bakes once and freezes at one phase).
        graphics.fillStyle(0xff4400, alpha * 0.15 * flame1);
        graphics.fillEllipse(fireX, fireY, 25, 12);

        // Flames (multi-layer)
        graphics.fillStyle(0xdd4400, alpha * flame3);
        graphics.beginPath();
        graphics.moveTo(fireX - 6, fireY);
        graphics.lineTo(fireX - 8, fireY - 12 - flame3 * 5);
        graphics.lineTo(fireX - 3, fireY - 8);
        graphics.lineTo(fireX - 5, fireY - 18 - flame2 * 6);
        graphics.lineTo(fireX, fireY - 10);
        graphics.lineTo(fireX + 2, fireY - 16 - flame1 * 5);
        graphics.lineTo(fireX + 5, fireY - 6);
        graphics.lineTo(fireX + 7, fireY - 14 - flame3 * 4);
        graphics.lineTo(fireX + 6, fireY);
        graphics.closePath();
        graphics.fillPath();

        graphics.fillStyle(0xff6600, alpha * flame1);
        graphics.beginPath();
        graphics.moveTo(fireX - 5, fireY);
        graphics.lineTo(fireX - 6, fireY - 10 - flame2 * 4);
        graphics.lineTo(fireX - 2, fireY - 7);
        graphics.lineTo(fireX - 3, fireY - 15 - flame1 * 5);
        graphics.lineTo(fireX + 1, fireY - 9);
        graphics.lineTo(fireX + 3, fireY - 13 - flame3 * 4);
        graphics.lineTo(fireX + 5, fireY - 5);
        graphics.lineTo(fireX + 5, fireY);
        graphics.closePath();
        graphics.fillPath();

        graphics.fillStyle(0xffaa00, alpha * flame2);
        graphics.beginPath();
        graphics.moveTo(fireX - 3, fireY);
        graphics.lineTo(fireX - 4, fireY - 7 - flame1 * 3);
        graphics.lineTo(fireX - 1, fireY - 5);
        graphics.lineTo(fireX, fireY - 11 - flame2 * 4);
        graphics.lineTo(fireX + 2, fireY - 6);
        graphics.lineTo(fireX + 3, fireY - 8 - flame3 * 3);
        graphics.lineTo(fireX + 3, fireY);
        graphics.closePath();
        graphics.fillPath();

        graphics.fillStyle(0xffdd44, alpha * flame3);
        graphics.beginPath();
        graphics.moveTo(fireX - 2, fireY);
        graphics.lineTo(fireX - 2, fireY - 5 - flame2 * 2);
        graphics.lineTo(fireX, fireY - 8 - flame1 * 3);
        graphics.lineTo(fireX + 2, fireY - 4 - flame3 * 2);
        graphics.lineTo(fireX + 2, fireY);
        graphics.closePath();
        graphics.fillPath();

        // Fire sparks rising (one 40-unit cycle per 1500 ms loop; i*8 staggers)
        for (let i = 0; i < 5; i++) {
            const sparkPhase = (time / 37.5 + i * 8) % 40;
            if (sparkPhase < 35) {
                const sparkRise = sparkPhase * 0.7;
                const sparkDrift = Math.sin(sparkPhase * 0.3 + i) * 4;
                const sparkAlpha = 1 - sparkPhase / 35;
                graphics.fillStyle(0xffaa44, alpha * sparkAlpha * 0.8);
                graphics.fillCircle(fireX + sparkDrift + (i - 2) * 2, fireY - 15 - sparkRise, 1.2);
            }
        }

        if (showDummy) {
            // === TRAINING DUMMY ===
            const dummyX = center.x - 35;
            const dummyY = center.y - 5;

            // Dummy post
            graphics.fillStyle(0x5d4e37, alpha);
            graphics.fillRect(dummyX - 2, dummyY - 25, 4, 30);
            graphics.fillStyle(0x3d2e17, alpha);
            graphics.fillRect(dummyX + 1, dummyY - 25, 1, 30);

            // Dummy body (straw-stuffed sack)
            graphics.fillStyle(0xc4a060, alpha);
            graphics.fillEllipse(dummyX, dummyY - 18, 8, 12);
            graphics.fillStyle(0xa48040, alpha * 0.6);
            graphics.fillEllipse(dummyX + 2, dummyY - 18, 5, 10);

            // Dummy head
            graphics.fillStyle(0xc4a060, alpha);
            graphics.fillCircle(dummyX, dummyY - 32, 6);
            graphics.fillStyle(0xa48040, alpha * 0.5);
            graphics.fillCircle(dummyX + 1, dummyY - 32, 4);

            // Dummy arms (wooden crossbar — marble at L4)
            graphics.fillStyle(isLevel4 ? 0xccccbb : 0x5d4e37, alpha);
            graphics.fillRect(dummyX - 10, dummyY - 22, 20, 3);

            // Straw detail
            graphics.lineStyle(1, 0x8a7030, alpha * 0.6);
            graphics.lineBetween(dummyX - 4, dummyY - 10, dummyX - 6, dummyY - 5);
            graphics.lineBetween(dummyX + 3, dummyY - 10, dummyX + 5, dummyY - 6);
            graphics.lineBetween(dummyX, dummyY - 10, dummyX, dummyY - 4);
        }

        if (showWeaponRack) {
            // === WEAPON RACK (right side) ===
            const rackX = center.x + 35;
            const rackY = center.y;

            // Rack frame (A-frame)
            graphics.fillStyle(0x5d4e37, alpha);
            // Left leg
            graphics.beginPath();
            graphics.moveTo(rackX - 10, rackY + 5);
            graphics.lineTo(rackX - 8, rackY - 20);
            graphics.lineTo(rackX - 5, rackY - 20);
            graphics.lineTo(rackX - 7, rackY + 5);
            graphics.closePath();
            graphics.fillPath();

            // Right leg
            graphics.beginPath();
            graphics.moveTo(rackX + 10, rackY + 5);
            graphics.lineTo(rackX + 8, rackY - 20);
            graphics.lineTo(rackX + 5, rackY - 20);
            graphics.lineTo(rackX + 7, rackY + 5);
            graphics.closePath();
            graphics.fillPath();

            // Cross bar
            graphics.fillRect(rackX - 9, rackY - 18, 18, 3);
            graphics.fillStyle(0x3d2e17, alpha);
            graphics.fillRect(rackX - 9, rackY - 16, 18, 1);

            // Weapons on rack
            // Sword 1
            graphics.fillStyle(0x888888, alpha);
            graphics.fillRect(rackX - 7, rackY - 30, 2, 14);
            graphics.fillStyle(0x5d4e37, alpha);
            graphics.fillRect(rackX - 8, rackY - 17, 4, 3);
            graphics.fillStyle(0xccaa00, alpha);
            graphics.fillRect(rackX - 7, rackY - 17, 2, 1);

            // Sword 2
            graphics.fillStyle(0x777777, alpha);
            graphics.fillRect(rackX + 1, rackY - 28, 2, 12);
            graphics.fillStyle(0x5d4e37, alpha);
            graphics.fillRect(rackX, rackY - 17, 4, 3);
            graphics.fillStyle(0xccaa00, alpha);
            graphics.fillRect(rackX + 1, rackY - 17, 2, 1);

            // Axe
            graphics.fillStyle(0x5d4e37, alpha);
            graphics.fillRect(rackX + 6, rackY - 32, 2, 16);
            graphics.fillStyle(0x666666, alpha);
            graphics.beginPath();
            graphics.moveTo(rackX + 5, rackY - 32);
            graphics.lineTo(rackX + 11, rackY - 30);
            graphics.lineTo(rackX + 11, rackY - 26);
            graphics.lineTo(rackX + 5, rackY - 24);
            graphics.closePath();
            graphics.fillPath();
        }
    }
}

    /**
     * WALLS — overlap-proof isometric partition.
     *
     * Every tile draws exactly: its corner post, plus connector bars running
     * SOUTH and EAST from its own centre to the neighbouring tile's centre.
     * Connections to the north/west are owned by those neighbours. Because
     * every piece of geometry extends only down-screen from its owning tile,
     * painter's order by tile depth is exactly back-to-front — a nearer tile
     * can never incorrectly paint over a farther tile's faces — and every
     * bar end is hidden underneath the next tile's post, so runs are
     * seamless at any shape: lines, corners, T's, crosses and staircases.
     *
     * Levels: wooden stakes (1) -> sandstone (2) -> dark rampart (3) ->
     * gold-crowned stone (4).
     */
    /**
     * Wall contact shadow — the ground pass walls never had (guide §4 says
     * EVERY building gets one; shadowless posts read as floating up-left of
     * their tile). Baked into the per-topology wall ground decal and stamped
     * under the body by SpriteBank.syncBuilding's wall-ground slot; the full
     * vector draw (kill switch, postcards) paints it directly under the post.
     *
     * ONE closed polygon at uniform alpha (guide §8 — stacked sub-shapes
     * double-darken). The union is computed in CART space where every piece
     * is axis-aligned: a square pad under the post, slim strips under the
     * tile's own S/E connector bars (center-to-center, same partition as the
     * bars themselves, so neighbouring decals butt instead of stacking).
     */
    static drawWallShadow(graphics: Phaser.GameObjects.Graphics, gridX: number, gridY: number, alpha: number, neighbors: { nN: boolean, nS: boolean, nE: boolean, nW: boolean }) {
        const { nN, nS, nE, nW } = neighbors;
        const isStraight = (nN && nS && !nE && !nW) || (nE && nW && !nN && !nS);
        const hasPost = !isStraight;
        const a = 0.28;   // post pad half-size (post base is ~0.19 + breathing room)
        const b = 0.175;  // connector strip half-width (bar hw ~0.12 + margin)
        const cx = gridX + 0.5;
        const cy = gridY + 0.5;
        // Trace the rectilinear union clockwise (cart offsets from the tile
        // center; +x = east, +y = south). Bars run center-to-center like the
        // wall bars: the strip under a bar entering a neighbour post tucks
        // beneath that post's opaque base, so no visible double-darkening.
        let pts: [number, number][];
        if (hasPost) {
            if (nE && nS) {
                pts = [[-a, -a], [a, -a], [a, -b], [1, -b], [1, b], [a, b], [a, a], [b, a], [b, 1], [-b, 1], [-b, a], [-a, a]];
            } else if (nE) {
                pts = [[-a, -a], [a, -a], [a, -b], [1, -b], [1, b], [a, b], [a, a], [-a, a]];
            } else if (nS) {
                pts = [[-a, -a], [a, -a], [a, a], [b, a], [b, 1], [-b, 1], [-b, a], [-a, a]];
            } else {
                pts = [[-a, -a], [a, -a], [a, a], [-a, a]];
            }
        } else if (nE) { // EW straight run: own E half-bar (W half belongs to the west neighbour)
            pts = [[0, -b], [1, -b], [1, b], [0, b]];
        } else {         // NS straight run
            pts = [[-b, 0], [b, 0], [b, 1], [-b, 1]];
        }
        graphics.fillStyle(0x18220f, alpha * 0.3);
        graphics.beginPath();
        pts.forEach(([dx, dy], i) => {
            const p = IsoUtils.cartToIso(cx + dx, cy + dy);
            if (i === 0) graphics.moveTo(p.x, p.y + 1);
            else graphics.lineTo(p.x, p.y + 1);
        });
        graphics.closePath();
        graphics.fillPath();
    }

    static drawWall(graphics: Phaser.GameObjects.Graphics, _center: Phaser.Math.Vector2, gridX: number, gridY: number, alpha: number, tint: number | null, building: any, neighbors: { nN: boolean, nS: boolean, nE: boolean, nW: boolean, owner: string }) {
        const level = Math.max(1, Math.min(4, Number(building?.level) || 1));
        const { nN, nS, nE, nW } = neighbors;
        // Straight runs stay slim and continuous; posts mark corners,
        // junctions, dead ends and lone blocks — the Clash-like rhythm.
        const isStraight = (nN && nS && !nE && !nW) || (nE && nW && !nN && !nS);

        // ---- Level styling ----
        const cfg = level >= 4 ? {
            h: 20, hw: 0.125, top: tint ?? 0xd8d2c0, front: 0xb3ac98, side: 0x968f7c,
            seam: 0x8a8370, cap: 'gold' as const
        } : level >= 3 ? {
            h: 19, hw: 0.13, top: tint ?? 0x4f4f60, front: 0x3c3c4c, side: 0x2d2d3a,
            seam: 0x23232e, cap: 'iron' as const
        } : level >= 2 ? {
            h: 15, hw: 0.115, top: tint ?? 0xd4c4a8, front: 0xa89878, side: 0x8a7a68,
            seam: 0x776a58, cap: 'stone' as const
        } : {
            h: 16, hw: 0.11, top: tint ?? 0x8b6b4a, front: 0x6b4a30, side: 0x5a3a20,
            seam: 0x4a2a15, cap: 'stake' as const
        };
        const H = cfg.h;
        const hw = cfg.hw;
        const cx = gridX + 0.5;
        const cy = gridY + 0.5;

        const quad = (pts: { x: number, y: number }[], color: number, a: number = alpha) => {
            graphics.fillStyle(color, a);
            graphics.beginPath();
            graphics.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) graphics.lineTo(pts[i].x, pts[i].y);
            graphics.closePath();
            graphics.fillPath();
        };
        const up = (p: { x: number, y: number }, dy: number = H) => ({ x: p.x, y: p.y - dy });

        // Bars begin at the post's face on post tiles, at the centre otherwise.
        const barStart = isStraight ? 0 : hw + 0.07;

        if (!isStraight) {
            // ---- POST: corners, junctions, ends and lone blocks only.
            // Drawn BEFORE the bars: the bars emerge from its south/east faces
            // and correctly wrap in front of its base.
            const ps = hw + 0.07;
            const pH = H + 3;
            const pTL = IsoUtils.cartToIso(cx - ps, cy - ps);
            const pTR = IsoUtils.cartToIso(cx + ps, cy - ps);
            const pBR = IsoUtils.cartToIso(cx + ps, cy + ps);
            const pBL = IsoUtils.cartToIso(cx - ps, cy + ps);
            // East face
            quad([pTR, pBR, up(pBR, pH), up(pTR, pH)], cfg.side);
            // South face
            quad([pBR, pBL, up(pBL, pH), up(pBR, pH)], cfg.front);
            // Top
            quad([up(pTL, pH), up(pTR, pH), up(pBR, pH), up(pBL, pH)], cfg.top);

            const capX = (pTL.x + pBR.x) / 2;
            const capY = (pTL.y + pBR.y) / 2 - pH;

            if (cfg.cap === 'stake') {
                // Sharpened wooden stake: four-sided point
                const peakY = capY - 4;
                quad([{ x: capX, y: peakY }, up(pTR, pH), up(pBR, pH)], 0x9b7b5a);
                quad([{ x: capX, y: peakY }, up(pBR, pH), up(pBL, pH)], 0x7b5b3a);
                // Rope lashing on the front face
                graphics.lineStyle(1.6, 0x8a7a5a, alpha);
                graphics.lineBetween(capX - 3, capY + pH * 0.55, capX + 3, capY + pH * 0.55);
            } else if (cfg.cap === 'stone') {
                // Flat coping slab with a slight overhang
                const o = 1.2;
                quad([
                    { x: up(pTL, pH).x - o, y: up(pTL, pH).y - 2 }, { x: up(pTR, pH).x, y: up(pTR, pH).y - o * 0.5 - 2 },
                    { x: up(pBR, pH).x + o, y: up(pBR, pH).y - 2 }, { x: up(pBL, pH).x, y: up(pBL, pH).y + o * 0.5 - 2 }
                ], 0xe2d4b8);
                quad([
                    { x: up(pBL, pH).x, y: up(pBL, pH).y + o * 0.5 - 2 }, { x: up(pBR, pH).x + o, y: up(pBR, pH).y - 2 },
                    { x: up(pBR, pH).x + o, y: up(pBR, pH).y + 1 }, { x: up(pBL, pH).x, y: up(pBL, pH).y + o * 0.5 + 1 }
                ], 0x8a7a68);
            } else if (cfg.cap === 'iron') {
                // Riveted iron cap band
                quad([
                    up(pTL, pH + 2.5), up(pTR, pH + 2.5), up(pBR, pH + 2.5), up(pBL, pH + 2.5)
                ], 0x62626e);
                quad([
                    up(pBR, pH + 2.5), up(pBL, pH + 2.5), up(pBL, pH), up(pBR, pH)
                ], 0x4a4a56);
                graphics.fillStyle(0x7a7a88, alpha);
                graphics.fillCircle(capX, capY - 1.4, 1.1);
            } else {
                // Gold pyramid crown, inset so a stone rim frames it
                const inset = (p: { x: number, y: number }) => ({
                    x: p.x + (capX - p.x) * 0.34,
                    y: p.y + (capY - p.y) * 0.34
                });
                const iTR = inset(up(pTR, pH));
                const iBR = inset(up(pBR, pH));
                const iBL = inset(up(pBL, pH));
                const peakY = capY - 4.5;
                quad([{ x: capX, y: peakY }, iTR, iBR], 0xffd700);
                quad([{ x: capX, y: peakY }, iBR, iBL], 0xb8860b);
                graphics.fillStyle(0xffe9a0, alpha);
                graphics.fillCircle(capX, peakY, 0.9);
            }

        }

        // ---- EAST bar: own centre -> east neighbour's centre ----
        if (nE) {
            const x0 = cx + barStart;
            const nw = IsoUtils.cartToIso(x0, cy - hw);
            const ne = IsoUtils.cartToIso(cx + 1, cy - hw);
            const se = IsoUtils.cartToIso(cx + 1, cy + hw);
            const sw = IsoUtils.cartToIso(x0, cy + hw);
            // South (front) face
            quad([sw, se, up(se), up(sw)], cfg.front);
            // Top
            quad([up(nw), up(ne), up(se), up(sw)], cfg.top);
            // A single mortar/grain tick keeps the slim face quiet
            graphics.lineStyle(1, cfg.seam, alpha * 0.45);
            const emx = (sw.x + se.x) / 2;
            const emy = (sw.y + se.y) / 2;
            graphics.lineBetween(emx - 5, emy - H * 0.45 + 2.5, emx + 5, emy - H * 0.45 + 7.5);
            if (level >= 4) {
                // Gold cornice along the top's front edge
                graphics.lineStyle(1.6, 0xdaa520, alpha * 0.95);
                graphics.lineBetween(up(sw).x, up(sw).y, up(se).x, up(se).y);
            }
        }

        // ---- SOUTH bar: own centre -> south neighbour's centre ----
        if (nS) {
            const y0 = cy + barStart;
            const nw = IsoUtils.cartToIso(cx - hw, y0);
            const ne = IsoUtils.cartToIso(cx + hw, y0);
            const se = IsoUtils.cartToIso(cx + hw, cy + 1);
            const sw = IsoUtils.cartToIso(cx - hw, cy + 1);
            // East (side) face
            quad([ne, se, up(se), up(ne)], cfg.side);
            // Top
            quad([up(nw), up(ne), up(se), up(sw)], cfg.top);
            graphics.lineStyle(1, cfg.seam, alpha * 0.45);
            const smx = (ne.x + se.x) / 2;
            const smy = (ne.y + se.y) / 2;
            graphics.lineBetween(smx - 5, smy - H * 0.45 + 2.5, smx + 5, smy - H * 0.45 - 2.5);
            if (level >= 4) {
                graphics.lineStyle(1.6, 0xdaa520, alpha * 0.95);
                graphics.lineBetween(up(ne).x, up(ne).y, up(se).x, up(se).y);
            }
        }

   }

    /**
     * DRAGONS BREATH — sixteen-pod firecracker battery.
     *
     * Level 1 is a lacquered temple platform of rocket silos. At max level it
     * becomes THE DRAGON ALTAR: the platform is the dragon. A gilded head
     * rears from the centre of the battery with molten veins feeding every
     * silo, jade eyes that smoulder while reloading, a jaw that runs
     * white-hot during a salvo, and a crest of golden spines breaking
     * through the deck along the northern rim.
     *
     * The pod state machine (stagger, launch, empty, rise-from-silo reload)
     * is driven purely by building.lastFireTime, in sync with MainScene.
     */
    static drawDragonsBreath(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building ?: any, baseGraphics ?: Phaser.GameObjects.Graphics, gridX: number = 0, gridY: number = 0, time: number = 0, skipBase: boolean = false, onlyBase: boolean = false) {
        const g = baseGraphics || graphics;
        const level = Number(building?.level) || 1;
        const isLevel2 = level >= 2;

        const quad = (gr: Phaser.GameObjects.Graphics, pts: number[][], color: number, a: number) => {
            gr.fillStyle(color, a);
            gr.beginPath();
            gr.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) gr.lineTo(pts[i][0], pts[i][1]);
            gr.closePath();
            gr.fillPath();
        };

        // Firing state — extended salvo for 16 staggered pods
        const timeSinceFire = building?.lastFireTime ? (time - building.lastFireTime) : 100000;
        const fireRate = 3000;
        const salvoActive = timeSinceFire < 800;

        // ==== Idle ambient clock ====
        // Declared ambient period P = 2000 ms. EVERY idle term below is an
        // integer harmonic k of idleW (or a whole number of cycles per P) so
        // the bake's autocorrelation probe measures one clean loop — the old
        // ad-hoc rates (time/380, time/200, time/300, ...) never closed a
        // cycle and the battery baked as a frozen frame. Combat (salvo)
        // branches keep their exact original values.
        const idleW = (Math.PI * 2) / 2000;
        const mix = (cA: number, cB: number, t: number) => {
            const r = ((cA >> 16) & 0xff) + (((cB >> 16) & 0xff) - ((cA >> 16) & 0xff)) * t;
            const gc = ((cA >> 8) & 0xff) + (((cB >> 8) & 0xff) - ((cA >> 8) & 0xff)) * t;
            const b = (cA & 0xff) + ((cB & 0xff) - (cA & 0xff)) * t;
            return (Math.round(r) << 16) | (Math.round(gc) << 8) | Math.round(b);
        };

        if (!skipBase) {
            // ===== PLATFORM =====
            // Octagonal altar deck: the corners are cut so grass shows through
            // and the battery reads as an object on the lawn, not a tile plate.
            const baseColor = tint ?? (isLevel2 ? 0x241418 : 0x3a2a2a);
            const cut = 0.3;
            const corners = [c1, c2, c3, c4];
            const octo: Phaser.Math.Vector2[] = [];
            for (let i = 0; i < 4; i++) {
                const a2 = corners[i];
                const b2 = corners[(i + 1) % 4];
                octo.push(new Phaser.Math.Vector2(a2.x + (b2.x - a2.x) * cut, a2.y + (b2.y - a2.y) * cut));
                octo.push(new Phaser.Math.Vector2(a2.x + (b2.x - a2.x) * (1 - cut), a2.y + (b2.y - a2.y) * (1 - cut)));
            }
            g.fillStyle(baseColor, alpha);
            g.fillPoints(octo, true);
            g.fillStyle(isLevel2 ? 0x1a0d10 : 0x2a1a1a, alpha * 0.55);
            g.fillPoints(octo.map(pt => new Phaser.Math.Vector2(
                pt.x + (center.x - pt.x) * 0.12, pt.y + (center.y - pt.y) * 0.12
            )), true);
            g.lineStyle(isLevel2 ? 3 : 2, isLevel2 ? 0xdaa520 : 0xb8860b, alpha * (isLevel2 ? 0.95 : 0.8));
            g.strokePoints(octo, true, true);
            // Jade-in-gold studs at the four cut corners
            for (let i = 0; i < 8; i += 2) {
                const sx = (octo[i].x + octo[(i + 7) % 8].x) / 2;
                const sy = (octo[i].y + octo[(i + 7) % 8].y) / 2;
                g.fillStyle(isLevel2 ? 0xdaa520 : 0xb8860b, alpha);
                g.fillCircle(sx, sy, isLevel2 ? 4.5 : 3.6);
                g.fillStyle(0x3f8f5f, alpha * 0.95);
                g.fillCircle(sx, sy, isLevel2 ? 2.4 : 1.9);
            }
        }

        if (onlyBase) return;

        // ===== MOLTEN VEINS (max level): the dragon's blood feeds the silos =====
        if (isLevel2) {
            // Idle: the dragon's blood SURGES through the channels — a color
            // swing from deep cooled red to bright molten orange (k=1 of the
            // 2000 ms loop), phase-staggered per channel so the surge washes
            // across the deck. Color at fixed high alpha, never an alpha
            // shimmer: the bake's 50% alpha snap erases faint strokes.
            const veinColor = (ph: number) =>
                mix(0x76200f, 0xff5a1e, 0.5 + 0.5 * Math.sin(time * idleW + ph));
            if (salvoActive) graphics.lineStyle(1.6, 0xff5a1e, alpha * (0.75 + Math.sin(time / 60) * 0.25));
            for (let row = 0; row < 4; row++) {
                if (!salvoActive) graphics.lineStyle(1.8, veinColor(row * 1.1), alpha * 0.9);
                const a2 = IsoUtils.cartToIso(gridX + 0.5, gridY + row + 0.5);
                const b2 = IsoUtils.cartToIso(gridX + 3.5, gridY + row + 0.5);
                graphics.lineBetween(a2.x, a2.y + 2, b2.x, b2.y + 2);
            }
            for (let col = 0; col < 4; col++) {
                if (!salvoActive) graphics.lineStyle(1.8, veinColor(2.2 + col * 1.1), alpha * 0.9);
                const a2 = IsoUtils.cartToIso(gridX + col + 0.5, gridY + 0.5);
                const b2 = IsoUtils.cartToIso(gridX + col + 0.5, gridY + 3.5);
                graphics.lineBetween(a2.x, a2.y + 2, b2.x, b2.y + 2);
            }

            // Crest of golden back-spines breaking through the north rim
            for (let i = 0; i < 5; i++) {
                const t = 0.18 + i * 0.16;
                const sx = c1.x + (c2.x - c1.x) * t;
                const sy = c1.y + (c2.y - c1.y) * t + 3;
                const hgt = 7 + Math.sin(i * 1.9) * 2.5;
                quad(graphics, [
                    [sx - 3.4, sy], [sx + 3.4, sy], [sx + 0.6, sy - hgt]
                ], 0xb8860b, alpha);
                quad(graphics, [
                    [sx - 3.4, sy], [sx + 0.6, sy - hgt], [sx - 1, sy]
                ], 0xdaa520, alpha);
            }
        }

        // ===== 16 PODS on the 4x4 silo grid =====
        const drawPodTile = (row: number, col: number) => {
            const tileCenter = IsoUtils.cartToIso(gridX + col + 0.5, gridY + row + 0.5);
            const podIndex = row * 4 + col;

            // Silo pit + ring
            graphics.fillStyle(0x140808, alpha);
            graphics.fillEllipse(tileCenter.x, tileCenter.y + 2, 14, 7);
            graphics.lineStyle(2, isLevel2 ? 0xdaa520 : 0x6a4a2a, alpha);
            graphics.strokeEllipse(tileCenter.x, tileCenter.y + 2, 14, 7);
            if (isLevel2 && salvoActive) {
                // Silo glows as the dragon exhales
                graphics.fillStyle(0xff5a1e, alpha * (0.25 + Math.sin(time / 70 + podIndex) * 0.15));
                graphics.fillEllipse(tileCenter.x, tileCenter.y + 2, 11, 5.2);
            }

            // Pod state machine
            const podFireDelay = podIndex * 50;
            const podTimeSinceFire = timeSinceFire - podFireDelay;
            const isFuseGlowing = salvoActive && podTimeSinceFire > -100 && podTimeSinceFire <= 0;
            const isFiring = podTimeSinceFire > 0 && podTimeSinceFire < 200;
            const isEmpty = podTimeSinceFire >= 200 && timeSinceFire < 800;
            const isReloading = timeSinceFire >= 800;

            let podHeight = 28;
            let podVisible = true;
            if (isEmpty) {
                podVisible = false;
            } else if (isReloading) {
                const podReloadDelay = podIndex * 50;
                const podReloadTime = (timeSinceFire - 800) - podReloadDelay;
                const reloadDuration = 1500;
                if (podReloadTime < 0) {
                    podVisible = false;
                } else if (podReloadTime < reloadDuration) {
                    podHeight = (podReloadTime / reloadDuration) * 28;
                } else {
                    podHeight = 28;
                }
            } else if (isFiring) {
                // The projectile object takes over at ignition — the standing
                // rocket vanishes into it, so nothing is drawn here.
                podVisible = false;
            }
            void fireRate;

            // Launch smoke column lingering over a freshly fired silo
            if (BuildingRenderer.AMBIENT_VAPOR && podTimeSinceFire > 0 && podTimeSinceFire < 620) {
                for (let k = 0; k < 3; k++) {
                    const pt = podTimeSinceFire / 620 - k * 0.16;
                    if (pt <= 0 || pt >= 1) continue;
                    graphics.fillStyle(0xd8d2c8, alpha * (1 - pt) * 0.55);
                    graphics.fillCircle(
                        tileCenter.x + Math.sin(pt * 9 + podIndex + k * 2) * 3,
                        tileCenter.y - pt * 26,
                        2.2 + pt * 4.5
                    );
                }
            }

            // Ignition flash at the silo mouth
            if (podTimeSinceFire > 0 && podTimeSinceFire < 90) {
                graphics.fillStyle(0xffe9a0, alpha * 0.9);
                graphics.fillEllipse(tileCenter.x, tileCenter.y + 2, 13, 6);
                graphics.fillStyle(0xffffff, alpha * 0.9);
                graphics.fillEllipse(tileCenter.x, tileCenter.y + 2, 7, 3.4);
            }

            if (!podVisible) return;
            const baseY = tileCenter.y + 2;
            const topY = baseY - podHeight;
            const w = 5;

            // Rocket body: imperial red with a lit flank
            graphics.fillStyle(isLevel2 ? 0x9c1f1f : 0xa03028, alpha);
            graphics.fillRect(tileCenter.x - w, topY + 4, w * 2, Math.max(0, podHeight - 6));
            graphics.fillStyle(isLevel2 ? 0xc22e2e : 0xb84438, alpha);
            graphics.fillRect(tileCenter.x - w, topY + 4, w * 0.8, Math.max(0, podHeight - 6));
            // Rune band (max level) or paper band
            if (podHeight > 14) {
                graphics.lineStyle(1.3, isLevel2 ? 0xe6dcc2 : 0xd8c49a, alpha);
                graphics.lineBetween(tileCenter.x - w, baseY - 8, tileCenter.x + w, baseY - 8);
                if (isLevel2) {
                    graphics.fillStyle(0xffd700, alpha * 0.9);
                    graphics.fillCircle(tileCenter.x, baseY - 8, 1.4);
                }
            }
            // Nose cone
            quad(graphics, [
                [tileCenter.x - w, topY + 4.5], [tileCenter.x + w, topY + 4.5],
                [tileCenter.x, topY - 4]
            ], isLevel2 ? 0xdaa520 : 0x8a6a2a, alpha);
            if (isLevel2) {
                // Fin tails at the silo mouth
                quad(graphics, [
                    [tileCenter.x - w, baseY - 3], [tileCenter.x - w - 3, baseY + 1], [tileCenter.x - w, baseY + 0.5]
                ], 0xb8860b, alpha);
                quad(graphics, [
                    [tileCenter.x + w, baseY - 3], [tileCenter.x + w + 3, baseY + 1], [tileCenter.x + w, baseY + 0.5]
                ], 0xb8860b, alpha);
            }
            // Fuse — every armed pod keeps a live, sputtering spark. The old
            // (!isReloading && !salvoActive) gate was unreachable at rest
            // (timeSinceFire defaults huge, so isReloading was always true)
            // which is why the battery baked frozen; armed now means "fully
            // seated, outside a salvo". Idle terms are harmonics of the
            // 2000 ms loop: the spark crawls ~2 px along the fuse line (k=2)
            // with a fast shimmer (k=4), inside a slow per-pod color breath
            // deep-ember -> white-hot (k=1) that makes the full pattern
            // repeat exactly once per period. Alpha stays >= 0.75 — the
            // bake's 50% alpha snap erases anything fainter.
            if (isFuseGlowing || (!salvoActive && podHeight >= 28)) {
                graphics.lineStyle(1.2, 0x8a6a2a, alpha);
                graphics.lineBetween(tileCenter.x, topY - 4, tileCenter.x + 2.4, topY - 7.5);
                const sput = Math.sin(time * idleW * 2 + podIndex * 1.3);
                const shim = Math.sin(time * idleW * 4 + podIndex * 2.1);
                const glow = 0.5 + 0.5 * Math.sin(time * idleW + podIndex * 0.7);
                const sparkX = tileCenter.x + 2.4 + (isFuseGlowing ? 0 : 0.57 * sput + 0.33 * shim);
                const sparkY = topY - 7.5 + (isFuseGlowing ? 0 : -0.83 * sput + 0.23 * shim);
                graphics.fillStyle(isFuseGlowing ? 0xffd25e : mix(0xff8a26, 0xfff0b4, glow), alpha * (isFuseGlowing ? 1 : 0.75 + glow * 0.25));
                graphics.fillCircle(sparkX, sparkY, isFuseGlowing ? 2.2 : 1.5 + 0.25 * (sput + 1) + 0.1 * (shim + 1));
            }

        };

        // ===== THE DRAGON HEAD (max level centrepiece) =====
        const drawDragonHead = () => {
            const hx = center.x;
            const hy = center.y + 4;
            // Idle: the whole head assembly BREATHES on the 2000 ms ambient
            // loop (+-1.2 px vertical, k=1); rage feeds the aura and the
            // ember heat on the same slow cycle. Salvo pins both (combat
            // look unchanged).
            const breathe = salvoActive ? 0 : Math.sin(time * idleW) * 1.2;
            const rage = salvoActive ? 1 : 0.55 + Math.sin(time * idleW) * 0.25;

            // Heat aura under the head
            graphics.fillStyle(0xff5a1e, alpha * 0.16 * rage);
            graphics.fillEllipse(hx, hy, 44, 20);

            // Serpentine trunk: four lacquered scale rings rising and narrowing
            for (let i = 0; i < 4; i++) {
                // Upper rings inherit a share of the breath so the neck
                // flexes while the base ring stays seated on the deck.
                const ry = hy - i * 9 + breathe * (i / 3);
                const rw = 32 - i * 5;
                graphics.fillStyle(i % 2 === 0 ? 0x8a1c1c : 0xa32424, alpha);
                graphics.fillEllipse(hx, ry - 5, rw, rw * 0.46);
                graphics.lineStyle(1.4, 0xdaa520, alpha * 0.8);
                graphics.strokeEllipse(hx, ry - 5, rw, rw * 0.46);
            }

            // Skull, towering over the battery — everything below builds off
            // sy, so the whole head (horns, snout, maw, eyes, whiskers,
            // ember origin) rides the breath together.
            const sy = hy - 44 + breathe;
            graphics.fillStyle(0xdaa520, alpha);
            graphics.fillCircle(hx, sy, 12.5);
            graphics.fillStyle(0xf0c24a, alpha);
            graphics.fillCircle(hx - 3.6, sy - 3.6, 6.4);

            // Golden mane frill behind the skull
            for (const [fx, fy, fr] of [[-10, -8, 0], [0, -12, 0], [10, -8, 0]]) {
                void fr;
                quad(graphics, [
                    [hx + fx * 0.55, sy + fy * 0.55],
                    [hx + fx * 1.55, sy + fy * 1.55],
                    [hx + fx * 0.95 + (fx === 0 ? 4 : 0), sy + fy * 0.8 + 3]
                ], 0xb8860b, alpha);
            }

            // Horns swept back, grand
            graphics.lineStyle(4, 0xb8860b, alpha);
            graphics.lineBetween(hx - 7.5, sy - 8, hx - 16.5, sy - 19);
            graphics.lineBetween(hx + 7.5, sy - 8, hx + 16.5, sy - 19);
            graphics.lineStyle(2.2, 0xffd700, alpha);
            graphics.lineBetween(hx - 16.5, sy - 19, hx - 21.5, sy - 22.5);
            graphics.lineBetween(hx + 16.5, sy - 19, hx + 21.5, sy - 22.5);

            // Snout dropping toward the viewer, jaw open
            quad(graphics, [
                [hx - 9.5, sy + 3], [hx + 9.5, sy + 3],
                [hx + 7.4, sy + 16], [hx - 7.4, sy + 16]
            ], 0xdaa520, alpha);
            quad(graphics, [
                [hx - 7.4, sy + 16], [hx + 7.4, sy + 16],
                [hx + 5.4, sy + 21], [hx - 5.4, sy + 21]
            ], 0xb8860b, alpha);
            // Maw: molten glow between upper snout and lower jaw — idles as
            // a COLOR swing deep red -> bright molten (k=1, offset from the
            // breath); alpha stays fixed because the bake's alpha snap would
            // erase an alpha pulse.
            const mawT = salvoActive ? 1 : 0.5 + 0.5 * Math.sin(time * idleW + 2.1);
            quad(graphics, [
                [hx - 5.4, sy + 21], [hx + 5.4, sy + 21],
                [hx + 3.8, sy + 27.5], [hx - 3.8, sy + 27.5]
            ], 0x2a0d08, alpha);
            quad(graphics, [
                [hx - 4.2, sy + 21.8], [hx + 4.2, sy + 21.8],
                [hx + 3, sy + 26.4], [hx - 3, sy + 26.4]
            ], salvoActive ? 0xffe9a0 : mix(0x5f200d, 0xd8521a, mawT), alpha * 0.95);
            // Lower jaw
            quad(graphics, [
                [hx - 5, sy + 27.5], [hx + 5, sy + 27.5],
                [hx + 3.5, sy + 32.5], [hx - 3.5, sy + 32.5]
            ], 0xb8860b, alpha);
            // Fangs
            graphics.fillStyle(0xf8f4e8, alpha);
            quad(graphics, [[hx - 4.4, sy + 21], [hx - 2.4, sy + 21], [hx - 3.4, sy + 24.5]], 0xf8f4e8, alpha);
            quad(graphics, [[hx + 2.4, sy + 21], [hx + 4.4, sy + 21], [hx + 3.4, sy + 24.5]], 0xf8f4e8, alpha);

            // Jade eyes, smouldering
            // Eye ember cycles COLOR deep jade -> bright jade (k=2 — the
            // eyes smoulder twice per breath), fixed alpha for the bake.
            const eyeT = salvoActive ? 1 : 0.5 + 0.5 * Math.sin(time * idleW * 2 + 0.7);
            graphics.fillStyle(0x123a24, alpha);
            graphics.fillEllipse(hx - 6.4, sy + 5.4, 5.2, 3.8);
            graphics.fillEllipse(hx + 6.4, sy + 5.4, 5.2, 3.8);
            graphics.fillStyle(salvoActive ? 0x58e88a : mix(0x2a6e44, 0x64eb96, eyeT), alpha);
            graphics.fillEllipse(hx - 6.4, sy + 5.4, 3, 2.1);
            graphics.fillEllipse(hx + 6.4, sy + 5.4, 3, 2.1);

            // Whiskers
            graphics.lineStyle(1.4, 0xffd700, alpha * 0.85);
            graphics.lineBetween(hx - 7.5, sy + 13, hx - 17, sy + 10);
            graphics.lineBetween(hx - 17, sy + 10, hx - 21.5, sy + 14.5);
            graphics.lineBetween(hx + 7.5, sy + 13, hx + 17, sy + 10);
            graphics.lineBetween(hx + 17, sy + 10, hx + 21.5, sy + 14.5);

            // Breath embers rising from the maw
            for (let i = 0; i < (salvoActive ? 5 : 3); i++) {
                // Idle drift period 1000 ms = exactly 2 cycles per ambient
                // loop (the (1-t) alpha fade masks the wrap).
                const t = ((time / (salvoActive ? 420 : 1000)) + i * 0.37) % 1;
                const ex = hx + (i % 2 === 0 ? -3 : 3) + Math.sin(t * 7 + i * 2) * 3.4;
                const ey = sy + 19 - t * 24;
                graphics.fillStyle(t < 0.45 ? 0xffd25e : 0xff5a1e, alpha * (1 - t) * 0.9 * rage);
                graphics.fillCircle(ex, ey, 1.8 + (1 - t) * 1.3);
            }
        };

        // Rows are painted north to south; the head rises between the middle
        // rows so the rear pods peek behind it and the front pods overlap it.
        for (let row = 0; row < 4; row++) {
            if (isLevel2 && row === 2) drawDragonHead();
            for (let col = 0; col < 4; col++) drawPodTile(row, col);
        }
    }

    /**
     * JUKEBOX — a carved music cabinet with a brass horn. The front panel
     * glows and pulses to the beat while a chosen track is playing.
     */
    /**
     * JUKEBOX — a bard's music cabinet: a proper little iso box (SE dark,
     * SW lit) with a rounded crown, a violet glass panel on the SW face and
     * a brass horn blooming from the top. Gold stays a trim.
     */
    static drawJukebox(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, _building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0, playing: boolean = false) {
        const g = baseGraphics || graphics;
        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.8, 0.8);
        }
        if (onlyBase) return;

        const quad = (pts: number[][], color: number, a2: number) => {
            graphics.fillStyle(color, a2);
            graphics.beginPath();
            graphics.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) graphics.lineTo(pts[i][0], pts[i][1]);
            graphics.closePath();
            graphics.fillPath();
        };
        const lerp = (a2: Phaser.Math.Vector2, t: number): number[] => [
            center.x + (a2.x - center.x) * t,
            center.y + (a2.y - center.y) * t
        ];
        const up = (pt: number[], h: number): number[] => [pt[0], pt[1] - h];

        // Playing terms close every 2000 ms (glass pulse = harmonic 2, notes
        // below share the same 2000 ms period); the idle shimmer closes on
        // its own exact 5500 ms loop.
        const pulse = playing
            ? 0.62 + Math.sin(time * (Math.PI * 2) / 1000) * 0.34
            : 0.26 + Math.sin(time * (Math.PI * 2) / 5500) * 0.07;
        const woodLit = tint ?? 0x8a5c38;
        const woodDark = 0x6b4226;
        const woodTop = 0x9c6c42;

        // ===== CABINET (compact box, lawn breathes around it) =====
        const s = 0.58;
        const wallH = 17;
        const p1 = lerp(c1, s);
        const p2 = lerp(c2, s);
        const p3 = lerp(c3, s);
        const p4 = lerp(c4, s);
        quad([p2, p3, up(p3, wallH), up(p2, wallH)], woodDark, alpha); // SE dark
        quad([p3, p4, up(p4, wallH), up(p3, wallH)], woodLit, alpha); // SW lit
        quad([up(p1, wallH), up(p2, wallH), up(p3, wallH), up(p4, wallH)], woodTop, alpha);
        // Gold trim ringing the top edge
        graphics.lineStyle(1.4, 0xc9a227, alpha);
        graphics.beginPath();
        graphics.moveTo(p4[0], p4[1] - wallH);
        graphics.lineTo(p3[0], p3[1] - wallH);
        graphics.lineTo(p2[0], p2[1] - wallH);
        graphics.strokePath();

        // ===== ARCHED GLASS on the SW face (the classic jukebox arch,
        // built entirely in the wall plane with the door-skew helper) =====
        const dX = (p3[0] + p4[0]) / 2;
        const dY = (p3[1] + p4[1]) / 2;
        const sk = (p3[1] - p4[1]) / (p3[0] - p4[0]);
        const dp = (ox: number, h: number): number[] => [dX + ox, dY + ox * sk - h];
        const archPts = (halfW: number, hBase: number, hTop: number, rise: number): number[][] => {
            const pts: number[][] = [dp(-halfW, hBase), dp(halfW, hBase), dp(halfW, hTop)];
            for (let i = 0; i <= 10; i++) {
                const a3 = (i / 10) * Math.PI;
                pts.push(dp(halfW * Math.cos(a3), hTop + Math.sin(a3) * rise));
            }
            pts.push(dp(-halfW, hTop));
            return pts;
        };
        // Dark casing, then the glowing violet glass inside it
        quad(archPts(6.2, 2.5, 11, 4.6), 0x1a0f1e, alpha);
        quad(archPts(5, 3.2, 10.8, 3.6), 0xc98aff, alpha * pulse);
        // Speaker slats across the lower glass, in the same plane
        graphics.lineStyle(0.9, 0x1a0f1e, alpha * 0.8);
        for (let i = 0; i <= 2; i++) {
            const hh = 4.2 + i * 2;
            graphics.lineBetween(dp(-4, hh)[0], dp(-4, hh)[1], dp(4, hh)[0], dp(4, hh)[1]);
        }
        // Gold beading over the arch
        graphics.lineStyle(1.1, 0xc9a227, alpha);
        graphics.beginPath();
        for (let i = 0; i <= 12; i++) {
            const a3 = (i / 12) * Math.PI;
            const pt = dp(6.2 * Math.cos(a3), 11 + Math.sin(a3) * 4.6);
            if (i === 0) graphics.moveTo(pt[0], pt[1]); else graphics.lineTo(pt[0], pt[1]);
        }
        graphics.strokePath();

        // ===== BRASS GRAMOPHONE HORN rising from the top face =====
        // Axis points up-and-east; the rim disc is spanned by the axis
        // perpendicular + the vertical, so it faces along the horn.
        const topY = center.y - wallH;
        const bx = center.x + 3.5;
        const by = topY + 1.5;
        const dirX = 0.76, dirY = -0.65;
        const perpX = -dirY, perpY = dirX; // screen-space normal of the axis
        const hornLen = 15;
        const rimX = bx + dirX * hornLen;
        const rimY = by + dirY * hornLen;
        const rimR = 6.2;
        const rim = (t: number, r: number): number[] => [
            rimX + perpX * Math.cos(t) * r,
            rimY + perpY * Math.cos(t) * r + Math.sin(t) * r * 0.6
        ];
        // Tapered cone from a narrow throat to the rim
        quad([
            [bx + perpX * 1.6, by + perpY * 1.6],
            rim(0, rimR * 0.92),
            rim(Math.PI, rimR * 0.92),
            [bx - perpX * 1.6, by - perpY * 1.6]
        ], 0xd8b13a, alpha);
        // Throat elbow anchoring it to the cabinet
        graphics.fillStyle(0xb8922e, alpha);
        graphics.fillCircle(bx, by + 0.5, 2.4);
        // Rim: bright brass ring with a dark bore
        const ring: number[][] = [];
        for (let i = 0; i <= 14; i++) ring.push(rim((i / 14) * Math.PI * 2, rimR));
        quad(ring, 0xf2d268, alpha);
        const bore: number[][] = [];
        for (let i = 0; i <= 12; i++) bore.push(rim((i / 12) * Math.PI * 2, rimR * 0.55));
        quad(bore, 0x4a3410, alpha);

        // ===== CRANK on the SE face =====
        const eX = (p2[0] + p3[0]) / 2;
        const eY = (p2[1] + p3[1]) / 2;
        graphics.lineStyle(1.5, 0x8a6a1e, alpha);
        graphics.lineBetween(eX, eY - 7, eX + 3.5, eY - 9.5);
        graphics.fillStyle(0xc9a227, alpha);
        graphics.fillCircle(eX + 3.5, eY - 9.5, 1.5);

        // ===== MUSIC NOTES drifting out of the horn while a track plays =====
        // Three quavers on staggered clocks: each pops from the bore, rises
        // on a lazy sway, and melts away — brass and violet by turns, so the
        // song visibly belongs to this cabinet. Pure function of time.
        if (playing) {
            const note = (nx: number, ny: number, col: number, a2: number, sc: number, twin: boolean) => {
                graphics.fillStyle(col, a2);
                graphics.fillEllipse(nx, ny, 3.4 * sc, 2.4 * sc);
                graphics.lineStyle(1.1 * sc, col, a2);
                graphics.lineBetween(nx + 1.5 * sc, ny - 0.5 * sc, nx + 1.5 * sc, ny - 6.5 * sc);
                if (twin) {
                    graphics.fillEllipse(nx + 4.8 * sc, ny - 1 * sc, 3.4 * sc, 2.4 * sc);
                    graphics.lineBetween(nx + 6.3 * sc, ny - 1.5 * sc, nx + 6.3 * sc, ny - 7.3 * sc);
                    graphics.lineStyle(1.6 * sc, col, a2);
                    graphics.lineBetween(nx + 1.5 * sc, ny - 6.5 * sc, nx + 6.3 * sc, ny - 7.3 * sc);
                } else {
                    graphics.lineBetween(nx + 1.5 * sc, ny - 6.5 * sc, nx + 3.4 * sc, ny - 5.2 * sc);
                }
            };
            const sx0 = rimX + dirX * 2;
            const sy0 = rimY + dirY * 2;
            for (let i = 0; i < 3; i++) {
                // ONE shared 2000 ms period (the old 2000/2260/2520 trio
                // never co-repeated, so the loop could not close); the i*733
                // clock offsets keep the three quavers staggered.
                const period = 2000;
                const t = ((time + i * 733) % period) / period;
                const fade = Math.min(1, t / 0.15) * Math.max(0, 1 - Math.max(0, (t - 0.68) / 0.32));
                if (fade <= 0.01) continue;
                const sway = Math.sin(t * Math.PI * 2 + i * 2.1) * (2.4 + i * 0.5);
                const nx = sx0 + dirX * 7 * t + sway;
                const ny = sy0 + dirY * 7 * t - 19 * t;
                note(nx, ny, i % 2 === 0 ? 0xf2d268 : 0xc98aff, alpha * fade * 0.95, 0.8 + t * 0.3, i === 1);
            }
        }
    }

    /**
     * ORE MINE — a rocky dig with a timber head-frame, rope-and-bucket winch
     * and freshly mined ore glinting by the rim.
     */
    static drawMine(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        const g = baseGraphics || graphics;
        const level = Math.max(1, Number(building?.level) || 1);

        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.7, 0.68);
            // Compact trampled patch just under the works — the lawn keeps the rest
            const inset = (a: Phaser.Math.Vector2, f: number) => new Phaser.Math.Vector2(center.x + (a.x - center.x) * f, center.y + (a.y - center.y) * f);
            g.fillStyle(tint ?? 0x8a8272, alpha);
            g.fillPoints([inset(c1, 0.64), inset(c2, 0.64), inset(c3, 0.64), inset(c4, 0.64)], true);
            g.fillStyle(0x7a7264, alpha);
            g.fillPoints([inset(c1, 0.5), inset(c2, 0.5), inset(c3, 0.5), inset(c4, 0.5)], true);
            // A few stones kicked to the rim of the patch
            g.fillStyle(0x6b655a, alpha);
            for (let i = 0; i < 5; i++) {
                const a2 = (i / 5) * Math.PI * 2 + 0.6;
                g.fillEllipse(center.x + Math.cos(a2) * 19, center.y + 5 + Math.sin(a2) * 8, 3.2, 2);
            }
        }

        if (onlyBase) return;

        // The pit itself: a dark mouth with a stone rim
        graphics.fillStyle(0x4c463c, alpha);
        graphics.fillEllipse(center.x, center.y + 4, 30, 15);
        graphics.fillStyle(0x14100c, alpha);
        graphics.fillEllipse(center.x, center.y + 4, 24, 11);
        graphics.fillStyle(0x000000, alpha * 0.65);
        graphics.fillEllipse(center.x, center.y + 5, 18, 8);

        // Timber head-frame straddling the pit
        const legL = { x: center.x - 14, y: center.y + 6 };
        const legR = { x: center.x + 14, y: center.y + 6 };
        const apexY = center.y - 26;
        graphics.lineStyle(3, 0x5c4326, alpha);
        graphics.beginPath();
        graphics.moveTo(legL.x, legL.y);
        graphics.lineTo(center.x, apexY);
        graphics.lineTo(legR.x, legR.y);
        graphics.strokePath();
        graphics.lineStyle(2, 0x6d5230, alpha);
        graphics.lineBetween(center.x - 8, center.y - 9, center.x + 8, center.y - 9);
        // Pulley wheel + rope + bucket, creaking up and down
        graphics.fillStyle(0x3a2e1c, alpha);
        graphics.fillCircle(center.x, apexY + 3, 3.2);
        graphics.fillStyle(0x8a6a3a, alpha);
        graphics.fillCircle(center.x, apexY + 3, 1.4);
        const crewed = time < Number(building?.crewedUntil ?? 0);
        const bob = Math.sin(time / (crewed ? 340 : 900)) * 4;
        graphics.lineStyle(1, 0xb8a888, alpha);
        graphics.lineBetween(center.x, apexY + 6, center.x, center.y - 4 + bob);
        graphics.fillStyle(0x4a3a24, alpha);
        graphics.fillRect(center.x - 3, center.y - 4 + bob, 6, 4.5);

        // Mined ore piled by the rim — the heap grows with the production
        // cycle and shrinks back when a miner hauls it off.
        const fill = Math.max(0, Math.min(1, Number(building?.fillLevel ?? 1)));
        const pileX = center.x + 18;
        const pileY = center.y + 12;
        const glint = 0.75 + Math.sin(time / (crewed ? 240 : 480)) * 0.25;
        if (fill > 0.08) {
            const pile = 0.3 + fill * 0.7; // a few scraps even when freshly emptied
            graphics.fillStyle(0x6b6e78, alpha);
            graphics.fillEllipse(pileX, pileY, 13 * pile, 6.5 * pile);
            if (fill > 0.35) graphics.fillEllipse(pileX - 4, pileY - 3 * pile, 8 * pile, 4.5 * pile);
            graphics.fillStyle(0xffd84a, alpha * glint);
            graphics.fillCircle(pileX - 3 * pile, pileY - 3.4 * pile, 1.4);
            if (fill > 0.45) graphics.fillCircle(pileX + 3.4 * pile, pileY - 1, 1.2);
            if (fill > 0.75) graphics.fillCircle(pileX - 0.5, pileY + 1.4, 1);
        }

        // Higher levels: a second support brace and a bigger haul
        if (level >= 2) {
            graphics.lineStyle(2, 0x5c4326, alpha);
            graphics.lineBetween(legL.x + 3, legL.y - 8, legR.x - 3, legR.y - 8);
            if (fill > 0.55) {
                graphics.fillStyle(0x6b6e78, alpha);
                graphics.fillEllipse(pileX + 7, pileY + 2, 8 * fill, 4 * fill);
                graphics.fillStyle(0xffd84a, alpha * glint);
                graphics.fillCircle(pileX + 7, pileY + 1, 1.2);
            }
        }
        if (level >= 3) {
            // A lantern on the frame for the night shift
            graphics.fillStyle(0x2a2a2a, alpha);
            graphics.fillRect(center.x + 6.5, center.y - 12, 3, 4);
            graphics.fillStyle(0xffd76a, alpha * (0.65 + Math.sin(time / 300) * 0.25));
            graphics.fillRect(center.x + 7.2, center.y - 11.3, 1.6, 2.6);
        }
    }

    /**
     * FARM — tilled rows with swaying crops, a hay bale and a water trough.
     * The crops stand taller with each level.
     */
    static drawFarm(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        const g = baseGraphics || graphics;
        const level = Math.max(1, Number(building?.level) || 1);

        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.7, 0.82);
            const inset = (a: Phaser.Math.Vector2, f: number) => new Phaser.Math.Vector2(center.x + (a.x - center.x) * f, center.y + (a.y - center.y) * f);
            // Tilled soil bed
            g.fillStyle(tint ?? 0x6d4f30, alpha);
            g.fillPoints([inset(c1, 0.95), inset(c2, 0.95), inset(c3, 0.95), inset(c4, 0.95)], true);
            // Furrow rows following the long (c4->c2) axis
            g.lineStyle(1.6, 0x59402a, alpha * 0.9);
            for (let r = 1; r <= 4; r++) {
                const f = r / 5;
                const sx = c1.x + (c4.x - c1.x) * f;
                const sy = c1.y + (c4.y - c1.y) * f;
                const ex = c2.x + (c3.x - c2.x) * f;
                const ey = c2.y + (c3.y - c2.y) * f;
                g.lineBetween(
                    center.x + (sx - center.x) * 0.86, center.y + (sy - center.y) * 0.86,
                    center.x + (ex - center.x) * 0.86, center.y + (ey - center.y) * 0.86
                );
            }
        }

        if (onlyBase) return;

        // ===== IDLE LOOP TIME BASE (exact 3000 ms period) =====
        // The crop sway samples the CLOSED-LOOP wind (the live
        // windSwayAtScreen rates never co-repeat, so it can never bake) and
        // the per-stalk jitter + trough shimmer are exact harmonics of
        // wIdle — the whole idle closes at 3000 ms.
        const wIdle = (Math.PI * 2) / 3000;

        // Crops along the furrows: green sprouts push up, turn golden as they
        // ripen, and start over after each harvest run.
        const fill = Math.max(0, Math.min(1, Number(building?.fillLevel ?? 1)));
        const cropHeight = 1.5 + (3.5 + level * 2) * fill;
        // Stalks green up first, then gild: lerp green -> wheat gold.
        const lerpChannel = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);
        const ripen = Math.max(0, (fill - 0.4) / 0.6);
        const stalkColor = (lerpChannel(0x5f, 0xb8, ripen) << 16) | (lerpChannel(0xa8, 0x91, ripen) << 8) | lerpChannel(0x48, 0x2e, ripen);
        const headColor = (lerpChannel(0x6f, 0xe8, ripen) << 16) | (lerpChannel(0xbf, 0xc0, ripen) << 8) | lerpChannel(0x5a, 0x4a, ripen);
        for (let r = 1; r <= 4; r++) {
            const f = r / 5;
            const sx = c1.x + (c4.x - c1.x) * f;
            const sy = c1.y + (c4.y - c1.y) * f;
            const ex = c2.x + (c3.x - c2.x) * f;
            const ey = c2.y + (c3.y - c2.y) * f;
            for (let i = 1; i <= 5; i++) {
                const ff = i / 6;
                const px = center.x + ((sx + (ex - sx) * ff) - center.x) * 0.86;
                const py = center.y + ((sy + (ey - sy) * ff) - center.y) * 0.86;
                const sway = (windSwayLoopAtScreen(px, py, time, 3000) * 1.5 + Math.sin(time * wIdle + r + i) * 0.35) * (0.4 + fill);
                graphics.lineStyle(1.4, stalkColor, alpha);
                graphics.lineBetween(px, py, px + sway, py - cropHeight);
                // Grain heads only once the crop is past half grown.
                if (fill > 0.5) {
                    const headSize = (fill - 0.5) / 0.5;
                    graphics.fillStyle(headColor, alpha);
                    graphics.fillEllipse(px + sway, py - cropHeight - 1.2 * headSize, 2.4 * headSize, 3.4 * headSize);
                }
            }
        }

        // Hay bale in the near corner
        const hayX = center.x + (c3.x - center.x) * 0.62;
        const hayY = center.y + (c3.y - center.y) * 0.62 - 4;
        graphics.fillStyle(0xd0a848, alpha);
        graphics.fillEllipse(hayX, hayY, 12, 8);
        graphics.fillStyle(0xb8912e, alpha);
        graphics.fillEllipse(hayX, hayY, 5, 8);
        graphics.fillStyle(0xe0bc66, alpha);
        graphics.fillEllipse(hayX, hayY, 2.4, 8);

        // Water trough on the west corner
        const trX = center.x + (c4.x - center.x) * 0.6;
        const trY = center.y + (c4.y - center.y) * 0.6 - 2;
        graphics.fillStyle(0x5c4326, alpha);
        graphics.fillRect(trX - 7, trY - 3, 14, 6);
        const shimmer = 0.75 + Math.sin(time * wIdle) * 0.15;
        graphics.fillStyle(0x4a7a9e, alpha * shimmer);
        graphics.fillRect(trX - 5.6, trY - 1.8, 11.2, 3.4);

        if (level >= 2) {
            // Scarecrow keeping the sparrows honest
            const scX = center.x + (c1.x - center.x) * 0.55;
            const scY = center.y + (c1.y - center.y) * 0.55 + 2;
            graphics.lineStyle(2, 0x6d5230, alpha);
            graphics.lineBetween(scX, scY + 8, scX, scY - 6);
            graphics.lineBetween(scX - 6, scY - 2, scX + 6, scY - 2);
            graphics.fillStyle(0xc9a86a, alpha);
            graphics.fillCircle(scX, scY - 8, 3);
            graphics.fillStyle(0x8a3b2e, alpha);
            graphics.fillTriangle(scX - 3.4, scY - 9.5, scX + 3.4, scY - 9.5, scX, scY - 14);
        }
    }

    /**
     * STOREHOUSE — a squat timber barn under a hipped ridge roof, with grain
     * sacks and barrels stacked by the door. Keeps both the ore and the food.
     * No ground plate: like every other building it sits straight on the
     * lawn under a contact shadow. Levels: rough plank -> slate + iron ->
     * pale oak with gold trim.
     */
    static drawStorage(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, center: Phaser.Math.Vector2, alpha: number, tint: number | null, building?: any, baseGraphics?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false, time: number = 0) {
        const g = baseGraphics || graphics;
        const level = Math.max(1, Math.min(3, Number(building?.level) || 1));

        if (!skipBase) {
            BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 0.9, 0.8);
        }
        if (onlyBase) return;

        const quad = (pts: number[][], color: number, a2: number) => {
            graphics.fillStyle(color, a2);
            graphics.beginPath();
            graphics.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) graphics.lineTo(pts[i][0], pts[i][1]);
            graphics.closePath();
            graphics.fillPath();
        };
        const lerp = (a2: Phaser.Math.Vector2, t: number): number[] => [
            center.x + (a2.x - center.x) * t,
            center.y + (a2.y - center.y) * t
        ];
        const up = (pt: number[], h: number): number[] => [pt[0], pt[1] - h];

        // ===== LEVEL PALETTES =====
        const wallLit = tint ?? (level >= 3 ? 0xbfb49a : level >= 2 ? 0xa8875a : 0x9a7448);
        const wallDark = level >= 3 ? 0x9d9078 : level >= 2 ? 0x86653c : 0x7a5836;
        const roofLit = level >= 3 ? 0x6a4a2a : level >= 2 ? 0x67676f : 0x8a5a30;
        const roofDark = level >= 3 ? 0x523822 : level >= 2 ? 0x4f4f58 : 0x6b4423;
        const trim = level >= 3 ? 0xdaa520 : level >= 2 ? 0x3f3f48 : 0x5c4326;
        const seam = level >= 3 ? 0x8a8068 : level >= 2 ? 0x6d5230 : 0x5c4326;

        // ===== WALLS (box on a shrunken footprint) =====
        const s = 0.8;
        const wallH = 13 + level * 1.5;
        const p2 = lerp(c2, s);
        const p3 = lerp(c3, s);
        const p4 = lerp(c4, s);
        quad([p2, p3, up(p3, wallH), up(p2, wallH)], wallDark, alpha);
        quad([p3, p4, up(p4, wallH), up(p3, wallH)], wallLit, alpha);
        // Plank coursing
        graphics.lineStyle(1, seam, alpha * 0.55);
        for (let i = 1; i <= 2; i++) {
            const hh = (wallH * i) / 3;
            graphics.lineBetween(p4[0], p4[1] - hh, p3[0], p3[1] - hh);
            graphics.lineBetween(p3[0], p3[1] - hh, p2[0], p2[1] - hh);
        }

        // ===== BARN DOOR on the SW face, skewed into the wall plane =====
        const dX = (p3[0] + p4[0]) / 2;
        const dY = (p3[1] + p4[1]) / 2 - 0.5;
        const sk = (p3[1] - p4[1]) / (p3[0] - p4[0]);
        const dp = (ox: number, h: number): number[] => [dX + ox, dY + ox * sk - h];
        quad([dp(-6, -0.5), dp(6, -0.5), dp(6, 11.5), dp(-6, 11.5)], trim === 0xdaa520 ? 0x8a6a3a : trim, alpha);
        const doorOpen = Math.max(0, Math.min(1, Number(building?.doorOpen) || 0));
        if (doorOpen > 0.02) {
            quad([dp(-4.8, 0), dp(4.8, 0), dp(4.8, 10.8), dp(-4.8, 10.8)], 0x14100b, alpha);
            // Warm stores-light spilling out
            graphics.fillStyle(0xd8a648, alpha * 0.2 * doorOpen);
            graphics.fillEllipse(dX, dY - 5, 7, 8);
            const leaf = 9.6 * (1 - doorOpen * 0.85);
            quad([dp(-4.8, 0), dp(-4.8 + leaf, 0), dp(-4.8 + leaf, 10.8), dp(-4.8, 10.8)], 0x4a3a24, alpha);
        } else {
            quad([dp(-4.8, 0), dp(4.8, 0), dp(4.8, 10.8), dp(-4.8, 10.8)], 0x4a3a24, alpha);
            // Cross-brace
            graphics.lineStyle(1.4, 0x6d5230, alpha);
            graphics.lineBetween(dp(-4.8, 10.8)[0], dp(-4.8, 10.8)[1], dp(4.8, 0)[0], dp(4.8, 0)[1]);
            graphics.lineBetween(dp(4.8, 10.8)[0], dp(4.8, 10.8)[1], dp(-4.8, 0)[0], dp(-4.8, 0)[1]);
        }
        if (level >= 3) {
            // Small gold roundel above the door — the merchant's mark
            graphics.fillStyle(0xdaa520, alpha);
            graphics.fillCircle(dp(0, 14.5)[0], dp(0, 14.5)[1], 1.8);
        }
        // Hanging lantern beside the door — the storehouse's night light
        const [lx, ly] = dp(9.5, 9);
        const lamp = 0.6 + Math.sin(time / 340) * 0.25;
        graphics.lineStyle(1, 0x2a2a2a, alpha);
        graphics.lineBetween(lx, ly - 2.2, lx, ly - 4);
        graphics.fillStyle(0x2a2a2a, alpha);
        graphics.fillRect(lx - 1.5, ly - 2.4, 3, 4);
        graphics.fillStyle(0xffc36a, alpha * lamp);
        graphics.fillRect(lx - 0.9, ly - 1.8, 1.8, 2.8);

        // ===== HIPPED RIDGE ROOF (all four faces — nothing missing) =====
        const o = 1.16;
        const roofH = 9 + level;
        const r1 = up(lerp(c1, s * o), wallH);
        const r2 = up(lerp(c2, s * o), wallH);
        const r3 = up(lerp(c3, s * o), wallH);
        const r4 = up(lerp(c4, s * o), wallH);
        const q = s * 0.24;
        const RA = [center.x - (c2.x - c1.x) * q, center.y - (c2.y - c1.y) * q - wallH - roofH];
        const RB = [center.x + (c2.x - c1.x) * q, center.y + (c2.y - c1.y) * q - wallH - roofH];
        const mix = (a2: number[], b2: number[], t: number): number[] => [a2[0] + (b2[0] - a2[0]) * t, a2[1] + (b2[1] - a2[1]) * t];
        // Far slope and far hip first
        quad([r1, r2, RB, RA], roofDark, alpha * 0.92);
        quad([r4, r1, RA], roofLit, alpha * 0.92);
        // Near slope and near hip
        quad([r4, r3, RB, RA], roofLit, alpha);
        quad([r3, r2, RB], roofDark, alpha);
        // Plank courses on the near slope
        graphics.lineStyle(1, roofDark, alpha * 0.6);
        for (const t of [0.35, 0.7]) {
            const ta = mix(r4, RA, t);
            const tb = mix(r3, RB, t);
            graphics.lineBetween(ta[0], ta[1], tb[0], tb[1]);
        }
        // Eaves, near hip edge and ridge cap
        graphics.lineStyle(1.4, roofDark, alpha * 0.85);
        graphics.lineBetween(r4[0], r4[1], r3[0], r3[1]);
        graphics.lineBetween(r3[0], r3[1], r2[0], r2[1]);
        graphics.lineBetween(r3[0], r3[1], RB[0], RB[1]);
        graphics.lineStyle(2.2, trim, alpha);
        graphics.lineBetween(RA[0], RA[1], RB[0], RB[1]);
        if (level >= 3) {
            // Gold finials at the ridge ends
            graphics.fillStyle(0xffd700, alpha);
            graphics.fillCircle(RA[0], RA[1] - 0.5, 1.6);
            graphics.fillCircle(RB[0], RB[1] - 0.5, 1.6);
        }

        // ===== GOODS STACKED OUTSIDE (more with each level) =====
        const barrel = (bx: number, by: number) => {
            graphics.fillStyle(0x7a5230, alpha);
            graphics.fillEllipse(bx, by, 8, 9.5);
            graphics.fillStyle(0x8f6238, alpha);
            graphics.fillEllipse(bx, by - 4, 8, 3.4);
            graphics.lineStyle(1, 0x4a3a24, alpha);
            graphics.lineBetween(bx - 4, by, bx + 4, by);
        };
        const propX = center.x + (c2.x - center.x) * 0.72;
        const propY = center.y + (c2.y - center.y) * 0.72 + 6;
        barrel(propX, propY);
        if (level >= 2) barrel(propX + 8, propY + 4);
        const sackX = center.x + (c3.x - center.x) * 0.85;
        const sackY = center.y + (c3.y - center.y) * 0.85;
        graphics.fillStyle(0xc9ae86, alpha);
        graphics.fillEllipse(sackX, sackY, 8, 6.5);
        graphics.fillEllipse(sackX + 5.5, sackY + 2.5, 8, 6.5);
        graphics.fillStyle(0xb0966e, alpha);
        graphics.fillRect(sackX - 1.2, sackY - 4.4, 2.4, 2);
        if (level >= 3) {
            graphics.fillStyle(0xc9ae86, alpha);
            graphics.fillEllipse(sackX + 2.5, sackY - 3, 8, 6.5);
        }
    }

    static drawGenericBuilding(graphics: Phaser.GameObjects.Graphics, c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2, c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2, _center: Phaser.Math.Vector2, info: any, alpha: number, tint: number | null, baseGraphics ?: Phaser.GameObjects.Graphics, skipBase: boolean = false, onlyBase: boolean = false) {
    const color = tint ?? info.color;
    const height = 30 * Math.max(info.width, info.height);
    const t1 = new Phaser.Math.Vector2(c1.x, c1.y - height);
    const t2 = new Phaser.Math.Vector2(c2.x, c2.y - height);
    const t3 = new Phaser.Math.Vector2(c3.x, c3.y - height);
    const t4 = new Phaser.Math.Vector2(c4.x, c4.y - height);

    const g = baseGraphics || graphics;
    if (!skipBase) BuildingRenderer.groundShadow(g, c1, c2, c3, c4, _center, alpha, 1, 0.78);
    if (onlyBase) return;

    const darkColor = Phaser.Display.Color.IntegerToColor(color).darken(20).color;
    const lightColor = Phaser.Display.Color.IntegerToColor(color).brighten(10).color;

    graphics.fillStyle(darkColor, alpha);
    graphics.fillPoints([c2, c3, t3, t2], true);
    graphics.fillStyle(lightColor, alpha);
    graphics.fillPoints([c3, c4, t4, t3], true);

    graphics.lineStyle(1, 0x000000, 0.3 * alpha);
    graphics.strokePoints([c2, c3, t3, t2], true, true);
    graphics.strokePoints([c3, c4, t4, t3], true, true);

    const topColor = Phaser.Display.Color.IntegerToColor(color).brighten(25).color;
    graphics.fillStyle(topColor, alpha);
    graphics.fillPoints([t1, t2, t3, t4], true);
    graphics.lineStyle(2, 0xffffff, 0.15 * alpha);
    graphics.lineBetween(t1.x, t1.y, t2.x, t2.y);
    graphics.lineBetween(t1.x, t1.y, t4.x, t4.y);
}

    // ===== SPIKE LAUNCHER (TREBUCHET) =====
    static drawSpikeLauncher(
    graphics: Phaser.GameObjects.Graphics,
    c1: Phaser.Math.Vector2, c2: Phaser.Math.Vector2,
    c3: Phaser.Math.Vector2, c4: Phaser.Math.Vector2,
    center: Phaser.Math.Vector2, alpha: number, tint: number | null,
    building ?: any, time: number = 0,
    baseGraphics ?: Phaser.GameObjects.Graphics,
    skipBase: boolean = false, onlyBase: boolean = false
) {
    const g = baseGraphics || graphics;

    // BOUNCY reload with LOADER PERSON
    // Loader stays visible - sits at lever when ready, pulls lever to fire, loads ball after
    const timeSinceFire = building?.lastFireTime ? (time - building.lastFireTime) : 10000;
    const fireAnimDuration = 3000;

    // Get facing direction early for loader positioning
    const aimAngle = building?.ballistaAngle ?? 0;
    const facingLeft = Math.cos(aimAngle) < 0;
    const dirX = facingLeft ? -1 : 1; // Direction multiplier

    let armAngle = -1.4;
    let showProjectile = true;
    let loaderX = 0; // Default: sitting in CENTER
    let loaderY = 10;
    let showLoader = true;
    let loaderCarrying = false;
    let loaderPulling = false;
    let loaderSitting = true;
    let showFlyingBall = false; // Ball flying from loader to sling
    let flyingBallX = 0;
    let flyingBallY = 0;

    if (timeSinceFire < fireAnimDuration) {
        const t = timeSinceFire / fireAnimDuration;

        if (t < 0.05) {
            // PULL LEVER: Loader pulls lever to fire
            armAngle = -1.4;
            showProjectile = true;
            loaderPulling = true;
            loaderSitting = false;
            loaderX = 0; // Stay in center
            loaderY = 6;
        } else if (t < 0.15) {
            // RELEASE: Fast swing, loader watches
            const releaseT = (t - 0.05) / 0.10;
            armAngle = -1.4 + (1 - Math.pow(1 - releaseT, 2)) * 2.9;
            showProjectile = false;
            loaderSitting = false;
            loaderX = 0;
            loaderY = 8;
        } else if (t < 0.25) {
            // BOUNCE: Damped oscillation
            const bounceT = (t - 0.15) / 0.10;
            const decay = Math.exp(-bounceT * 5);
            armAngle = 1.5 + Math.sin(bounceT * Math.PI * 4) * decay * 0.35;
            showProjectile = false;
            loaderSitting = false;
            loaderX = 0;
            loaderY = 8;
        } else if (t < 0.48) {
            // LOADER WALKS TO ARM TIP (arm tip is in dirX direction when arm is down)
            const walkT = (t - 0.25) / 0.23;
            armAngle = 1.5;
            showProjectile = false;
            loaderCarrying = true;
            loaderSitting = false;
            // Walk from center toward arm tip
            loaderX = walkT * (18 * dirX);
            loaderY = 8 - walkT * 3;
        } else if (t < 0.58) {
            // THROW: Loader throws ball UP into sling
            const throwT = (t - 0.48) / 0.10;
            armAngle = 1.5;
            showProjectile = false;
            loaderSitting = false;
            loaderCarrying = false;
            loaderX = 18 * dirX;
            loaderY = 5;

            // Calculate actual arm tip position when arm is down (armAngle = 1.5)
            // armTipX = pivotX + cos(armAngle - PI/2) * armLength * mirrorX
            // At armAngle=1.5: cos(1.5 - 1.57) = cos(-0.07) ≈ 1, sin(-0.07) ≈ -0.07
            // So arm tip is nearly directly to the side (in dirX direction)
            const frameHeight = 35;
            const armLength = 40;
            const slingDrop = 8;
            const ballOffset = 5;

            // Arm tip is at: center + armLength * dirX horizontally, frameHeight - 2 down from center
            const armTipRelX = Math.cos(1.5 - Math.PI / 2) * armLength * dirX;
            const armTipRelY = -frameHeight + 2 + Math.sin(1.5 - Math.PI / 2) * armLength + slingDrop + ballOffset;

            // Ball starts above loader's head, ends at sling position
            const startBallX = 18 * dirX;
            const startBallY = 5 - 12; // Above loader's head
            const endBallX = armTipRelX;
            const endBallY = armTipRelY;

            showFlyingBall = true;
            // Arc: goes up then curves to sling
            flyingBallX = startBallX + (endBallX - startBallX) * throwT;
            flyingBallY = startBallY + (endBallY - startBallY) * throwT - Math.sin(throwT * Math.PI) * 20;
        } else if (t < 0.62) {
            // CATCH: Ball lands in sling
            armAngle = 1.5;
            showProjectile = true; // Ball now in sling!
            loaderSitting = false;
            loaderCarrying = false;
            loaderX = 18 * dirX;
            loaderY = 5;
        } else if (t < 0.92) {
            // WINCH: Loader walks back to center and operates winch
            const winchT = (t - 0.58) / 0.34;
            armAngle = 1.5 - (1 - Math.pow(1 - winchT, 3)) * 2.9;
            showProjectile = true;
            loaderSitting = false;
            if (winchT < 0.3) {
                // Walking back to center
                loaderX = (20 * dirX) * (1 - winchT / 0.3);
                loaderY = 5 + (winchT / 0.3) * 3;
            } else {
                // Operating winch at center
                loaderX = Math.sin((winchT - 0.3) * Math.PI * 8) * 2;
                loaderY = 8;
            }
        } else {
            // SETTLE & SIT: Loader sits at center
            const settleT = (t - 0.92) / 0.08;
            armAngle = -1.4 + Math.sin(settleT * Math.PI * 2) * 0.12 * (1 - settleT);
            showProjectile = true;
            loaderSitting = true;
            loaderX = 0;
            loaderY = 10;
        }
    } else {
        // IDLE: Loader sitting at center
        loaderSitting = true;
        loaderX = 0;
        loaderY = 10;
    }

    // ===== IDLE AMBIENT (P = 2000 ms, deterministic in `time`) =====
    // Breathing loader + a spike-tip glint; every term repeats exactly every
    // 2000 ms (the bake probe measures this loop). idleGate is 0 through the
    // whole fire animation and eases back in over 600 ms, so the idle blends
    // out of the settle pose without popping.
    const idleW = (Math.PI * 2) / 2000;
    const idleGate = Math.max(0, Math.min(1, (timeSinceFire - fireAnimDuration) / 600));
    const chestRise = Math.sin(time * idleW) * 0.8 * idleGate;
    const headRise = chestRise + Math.sin(time * idleW - 1.1) * 0.35 * idleGate;
    const headLook = (((time % 2000) + 2000) % 2000 < 1000 ? -0.7 : 0.7) * dirX * idleGate;

    // Facing variables for arm rendering
    const mirrorX = dirX;
    const facingOffset = Math.cos(aimAngle) * 0.15;

    // ===== LEVEL =====
    const level = Number(building?.level) || 1;
    const isLevel3 = level >= 3;
    const isLevel4 = level >= 4;

    // ===== COLORS =====
    const woodDark = tint ?? (isLevel4 ? 0x5a4030 : isLevel3 ? 0x3a2a20 : 0x5d4037);
    const woodMid = isLevel4 ? 0x74553c : isLevel3 ? 0x4a3830 : 0x795548;
    const woodLight = isLevel4 ? 0x8f6d4c : isLevel3 ? 0x5a4840 : 0x8d6e63;
    const metalDark = isLevel4 ? 0xb8860b : isLevel3 ? 0x2a2a2a : 0x424242;
    const metalMid = isLevel4 ? 0xdaa520 : isLevel3 ? 0x505050 : 0x616161;
    const ropeTan = isLevel4 ? 0xdaa520 : 0xb8a07a;
    const stoneGray = isLevel4 ? 0xcfc5ae : isLevel3 ? 0x606060 : 0x757575;
    const stoneDark = isLevel4 ? 0xafa58c : isLevel3 ? 0x3a3a3a : 0x5a5a5a;
    const ironPlate = isLevel4 ? 0xdaa520 : 0x555555;

    // ===== BASE PLATFORM (ground layer) =====
    if (!skipBase) {
        BuildingRenderer.groundShadow(g, c1, c2, c3, c4, center, alpha, 1, 0.72);
        const px = (t: number, a: Phaser.Math.Vector2) => center.x + (a.x - center.x) * t;
        const py = (t: number, a: Phaser.Math.Vector2) => center.y + (a.y - center.y) * t;
        const m1 = new Phaser.Math.Vector2(px(0.52, c1), py(0.52, c1) + 2);
        const m2 = new Phaser.Math.Vector2(px(0.52, c2), py(0.52, c2));
        const m3 = new Phaser.Math.Vector2(px(0.52, c3), py(0.52, c3) - 2);
        const m4 = new Phaser.Math.Vector2(px(0.52, c4), py(0.52, c4));
        g.fillStyle(woodDark, alpha * 0.85);
        g.fillPoints([m1, m2, m3, m4], true);
        g.lineStyle(1, isLevel4 ? 0xdaa520 : 0x4a3020, alpha * 0.5);
        for (let i = 1; i < 4; i++) {
            const t = i / 4;
            g.lineBetween(m1.x + (m2.x - m1.x) * t, m1.y + (m2.y - m1.y) * t, m4.x + (m3.x - m4.x) * t, m4.y + (m3.y - m4.y) * t);
        }
        }

    if (onlyBase) return;

    // ===== FRAME (A-Frame supports) =====
    const frameHeight = 35;
    const frameWidth = 18;

    // Left support leg
    graphics.fillStyle(woodDark, alpha);
    graphics.beginPath();
    graphics.moveTo(center.x - frameWidth, center.y + 8);
    graphics.lineTo(center.x - 6, center.y - frameHeight);
    graphics.lineTo(center.x - 3, center.y - frameHeight);
    graphics.lineTo(center.x - frameWidth + 4, center.y + 8);
    graphics.closePath();
    graphics.fillPath();

    // Right support leg
    graphics.beginPath();
    graphics.moveTo(center.x + frameWidth, center.y + 8);
    graphics.lineTo(center.x + 6, center.y - frameHeight);
    graphics.lineTo(center.x + 3, center.y - frameHeight);
    graphics.lineTo(center.x + frameWidth - 4, center.y + 8);
    graphics.closePath();
    graphics.fillPath();

    if (isLevel3 || isLevel4) {
        // Iron/gold reinforcement plates on legs
        graphics.fillStyle(ironPlate, alpha * 0.7);
        graphics.fillRect(center.x - frameWidth + 1, center.y, 5, 6);
        graphics.fillRect(center.x + frameWidth - 6, center.y, 5, 6);
        graphics.lineStyle(2, ironPlate, alpha * 0.6);
        graphics.lineBetween(center.x - 12, center.y - 5, center.x + 12, center.y - 5);
    }

    // Cross beam
    graphics.fillStyle(isLevel3 ? metalMid : woodMid, alpha);
    graphics.fillRect(center.x - 8, center.y - frameHeight - 2, 16, 5);

    // Pivot point (metal hub)
    graphics.fillStyle(metalMid, alpha);
    graphics.fillCircle(center.x, center.y - frameHeight + 2, isLevel3 ? 6 : 5);
    graphics.fillStyle(metalDark, alpha);
    graphics.fillCircle(center.x, center.y - frameHeight + 2, isLevel3 ? 4 : 3);

    if (isLevel3 || isLevel4) {
        // Gear teeth around pivot
        graphics.lineStyle(1, isLevel4 ? 0xffd700 : 0x777777, alpha * 0.6);
        for (let i = 0; i < 8; i++) {
            const ga = (i / 8) * Math.PI * 2;
            graphics.lineBetween(
                center.x + Math.cos(ga) * 5, center.y - frameHeight + 2 + Math.sin(ga) * 5,
                center.x + Math.cos(ga) * 7, center.y - frameHeight + 2 + Math.sin(ga) * 7
            );
        }
    }

    // ===== THROWING ARM =====
    const armLength = 40;
    // Apply facing offset so trebuchet leans toward target
    const armPivotX = center.x + facingOffset * 30;
    const armPivotY = center.y - frameHeight + 2;

    // Calculate arm endpoints based on angle (mirrorX flips arm direction)
    const armTipX = armPivotX + Math.cos(armAngle - Math.PI / 2) * armLength * mirrorX;
    const armTipY = armPivotY + Math.sin(armAngle - Math.PI / 2) * armLength;
    const counterweightX = armPivotX - Math.cos(armAngle - Math.PI / 2) * (armLength * 0.4) * mirrorX;
    const counterweightY = armPivotY - Math.sin(armAngle - Math.PI / 2) * (armLength * 0.4);

    // Arm beam
    graphics.lineStyle(5, woodMid, alpha);
    graphics.lineBetween(counterweightX, counterweightY, armTipX, armTipY);

    // Arm wood grain highlight
    graphics.lineStyle(2, woodLight, alpha * 0.5);
    graphics.lineBetween(counterweightX, counterweightY - 1, armTipX, armTipY - 1);

    // Counterweight
    graphics.fillStyle(stoneGray, alpha);
    graphics.fillRect(counterweightX - 8, counterweightY - 5, 16, 12);
    graphics.fillStyle(stoneDark, alpha);
    graphics.fillRect(counterweightX - 6, counterweightY - 3, 12, 8);

    // Sling/rope at arm tip
    graphics.lineStyle(2, ropeTan, alpha);
    const slingDrop = 8;
    graphics.lineBetween(armTipX - 3, armTipY, armTipX, armTipY + slingDrop);
    graphics.lineBetween(armTipX + 3, armTipY, armTipX, armTipY + slingDrop);

    // SPIKY PROJECTILE in sling (only visible when loaded)
    if (showProjectile) {
        const spX = armTipX;
        const spY = armTipY + slingDrop + 5;

        if (isLevel4) {
            // L4: White marble boulder with gold spikes
            const spikeScale = 1.3;
            const sp = (v: number) => Math.round(v * spikeScale);

            // White marble core
            graphics.fillStyle(0xeeeedd, alpha);
            graphics.fillCircle(spX, spY, 5 * spikeScale);
            graphics.fillStyle(0xddddcc, alpha * 0.6);
            graphics.fillCircle(spX + 1, spY + 1, 3 * spikeScale);

            // Gold spikes
            graphics.fillStyle(0xdaa520, alpha);
            graphics.fillTriangle(spX, spY - sp(5), spX - sp(2), spY - sp(11), spX + sp(2), spY - sp(11));
            graphics.fillTriangle(spX, spY + sp(5), spX - sp(2), spY + sp(11), spX + sp(2), spY + sp(11));
            graphics.fillTriangle(spX - sp(5), spY, spX - sp(11), spY - sp(2), spX - sp(11), spY + sp(2));
            graphics.fillTriangle(spX + sp(5), spY, spX + sp(11), spY - sp(2), spX + sp(11), spY + sp(2));
            graphics.fillTriangle(spX - sp(3), spY - sp(3), spX - sp(8), spY - sp(8), spX - sp(5), spY - sp(5));
            graphics.fillTriangle(spX + sp(3), spY - sp(3), spX + sp(8), spY - sp(8), spX + sp(5), spY - sp(5));
            graphics.fillTriangle(spX - sp(3), spY + sp(3), spX - sp(8), spY + sp(8), spX - sp(5), spY + sp(5));
            graphics.fillTriangle(spX + sp(3), spY + sp(3), spX + sp(8), spY + sp(8), spX + sp(5), spY + sp(5));

            // Gold spike highlights
            graphics.fillStyle(0xffd700, alpha * 0.8);
            graphics.fillTriangle(spX - 1, spY - sp(6), spX, spY - sp(10), spX + 1, spY - sp(10));
            graphics.fillTriangle(spX - sp(6), spY - 1, spX - sp(10), spY, spX - sp(10), spY + 1);

            // Gold tips
            graphics.fillStyle(0xffd700, alpha * 0.7);
            graphics.fillCircle(spX, spY - sp(11), 1.5);
            graphics.fillCircle(spX, spY + sp(11), 1.5);
            graphics.fillCircle(spX - sp(11), spY, 1.5);
            graphics.fillCircle(spX + sp(11), spY, 1.5);
        } else if (isLevel3) {
            // L3: Dark iron reinforced with red-hot tips
            const spikeScale = 1.2;
            const sp = (v: number) => Math.round(v * spikeScale);

            graphics.fillStyle(0x333333, alpha);
            graphics.fillCircle(spX, spY, 4 * spikeScale);

            graphics.fillStyle(0x888888, alpha);
            graphics.fillTriangle(spX, spY - sp(4), spX - sp(2), spY - sp(10), spX + sp(2), spY - sp(10));
            graphics.fillTriangle(spX, spY + sp(4), spX - sp(2), spY + sp(10), spX + sp(2), spY + sp(10));
            graphics.fillTriangle(spX - sp(4), spY, spX - sp(10), spY - sp(2), spX - sp(10), spY + sp(2));
            graphics.fillTriangle(spX + sp(4), spY, spX + sp(10), spY - sp(2), spX + sp(10), spY + sp(2));
            graphics.fillTriangle(spX - sp(3), spY - sp(3), spX - sp(7), spY - sp(7), spX - sp(5), spY - sp(5));
            graphics.fillTriangle(spX + sp(3), spY - sp(3), spX + sp(7), spY - sp(7), spX + sp(5), spY - sp(5));
            graphics.fillTriangle(spX - sp(3), spY + sp(3), spX - sp(7), spY + sp(7), spX - sp(5), spY + sp(5));
            graphics.fillTriangle(spX + sp(3), spY + sp(3), spX + sp(7), spY + sp(7), spX + sp(5), spY + sp(5));

            graphics.fillStyle(0xbbbbbb, alpha * 0.8);
            graphics.fillTriangle(spX - 1, spY - sp(5), spX, spY - sp(9), spX + 1, spY - sp(9));
            graphics.fillTriangle(spX - sp(5), spY - 1, spX - sp(9), spY, spX - sp(9), spY + 1);

            // Red-hot spike tips
            graphics.fillStyle(0xcc3300, alpha * 0.6);
            graphics.fillCircle(spX, spY - sp(10), 1.5);
            graphics.fillCircle(spX, spY + sp(10), 1.5);
            graphics.fillCircle(spX - sp(10), spY, 1.5);
            graphics.fillCircle(spX + sp(10), spY, 1.5);
        } else {
            // L1-L2: Basic grey spike ball
            const spikeScale = 1.0;
            const sp = (v: number) => Math.round(v * spikeScale);

            graphics.fillStyle(0x555555, alpha);
            graphics.fillCircle(spX, spY, 4);

            graphics.fillStyle(0xaaaaaa, alpha);
            graphics.fillTriangle(spX, spY - sp(4), spX - sp(2), spY - sp(10), spX + sp(2), spY - sp(10));
            graphics.fillTriangle(spX, spY + sp(4), spX - sp(2), spY + sp(10), spX + sp(2), spY + sp(10));
            graphics.fillTriangle(spX - sp(4), spY, spX - sp(10), spY - sp(2), spX - sp(10), spY + sp(2));
            graphics.fillTriangle(spX + sp(4), spY, spX + sp(10), spY - sp(2), spX + sp(10), spY + sp(2));
            graphics.fillTriangle(spX - sp(3), spY - sp(3), spX - sp(7), spY - sp(7), spX - sp(5), spY - sp(5));
            graphics.fillTriangle(spX + sp(3), spY - sp(3), spX + sp(7), spY - sp(7), spX + sp(5), spY - sp(5));
            graphics.fillTriangle(spX - sp(3), spY + sp(3), spX - sp(7), spY + sp(7), spX - sp(5), spY + sp(5));
            graphics.fillTriangle(spX + sp(3), spY + sp(3), spX + sp(7), spY + sp(7), spX + sp(5), spY + sp(5));

            graphics.fillStyle(0xcccccc, alpha * 0.8);
            graphics.fillTriangle(spX - 1, spY - sp(5), spX, spY - sp(9), spX + 1, spY - sp(9));
            graphics.fillTriangle(spX - sp(5), spY - 1, spX - sp(9), spY, spX - sp(9), spY + 1);
        }
    }

    // ===== ROPE WINCH (decoration) =====
    graphics.fillStyle(woodDark, alpha);
    graphics.fillRect(center.x + 12, center.y - 5, 8, 10);
    graphics.lineStyle(1, ropeTan, alpha * 0.8);
    for (let i = 0; i < 4; i++) {
        graphics.strokeCircle(center.x + 16, center.y - 2 + i * 2, 3);
    }

    // ===== SPIKE RACK (on right side) =====
    if (isLevel4) {
        // Marble rack with gold spikes
        graphics.fillStyle(0xeeeedd, alpha);
        graphics.fillRect(center.x + 17, center.y - 3, 6, 15);
        graphics.lineStyle(1, 0xdaa520, alpha * 0.8);
        graphics.strokeRect(center.x + 17, center.y - 3, 6, 15);
        graphics.fillStyle(0xdaa520, alpha);
        graphics.fillTriangle(center.x + 20, center.y - 8, center.x + 17, center.y + 1, center.x + 23, center.y + 1);
        graphics.fillTriangle(center.x + 20, center.y - 5, center.x + 16, center.y + 4, center.x + 24, center.y + 4);
        graphics.fillTriangle(center.x + 20, center.y - 2, center.x + 15, center.y + 7, center.x + 25, center.y + 7);
        graphics.fillStyle(0xffd700, alpha * 0.7);
        graphics.fillCircle(center.x + 20, center.y - 8, 1.5);
        graphics.fillCircle(center.x + 20, center.y - 5, 1.5);
    } else if (isLevel3) {
        graphics.fillStyle(ironPlate, alpha);
        graphics.fillRect(center.x + 17, center.y - 3, 6, 15);
        graphics.lineStyle(1, 0x777777, alpha * 0.6);
        graphics.strokeRect(center.x + 17, center.y - 3, 6, 15);
        graphics.fillStyle(0x888888, alpha);
        graphics.fillTriangle(center.x + 20, center.y - 8, center.x + 17, center.y + 1, center.x + 23, center.y + 1);
        graphics.fillTriangle(center.x + 20, center.y - 5, center.x + 16, center.y + 4, center.x + 24, center.y + 4);
        graphics.fillTriangle(center.x + 20, center.y - 2, center.x + 15, center.y + 7, center.x + 25, center.y + 7);
        graphics.fillStyle(0xcc3300, alpha * 0.5);
        graphics.fillCircle(center.x + 20, center.y - 8, 1.5);
        graphics.fillCircle(center.x + 20, center.y - 5, 1.5);
    } else {
        graphics.fillStyle(woodDark, alpha);
        graphics.fillRect(center.x + 18, center.y - 2, 4, 14);
        graphics.fillStyle(0xaaaaaa, alpha);
        graphics.fillTriangle(center.x + 20, center.y - 6, center.x + 18, center.y + 2, center.x + 22, center.y + 2);
        graphics.fillTriangle(center.x + 20, center.y - 3, center.x + 17, center.y + 5, center.x + 23, center.y + 5);
        graphics.fillTriangle(center.x + 20, center.y, center.x + 16, center.y + 8, center.x + 24, center.y + 8);
        graphics.fillStyle(0xcccccc, alpha * 0.7);
        graphics.fillTriangle(center.x + 19, center.y - 5, center.x + 19, center.y - 1, center.x + 21, center.y - 1);
    }

    // ===== SPIKE AMMO PILE (left side - bigger and spikier) =====
    // Metal core balls with spikes — L4 gold
    graphics.fillStyle(isLevel4 ? 0xb8860b : 0x666666, alpha);
    graphics.fillCircle(center.x - 14, center.y + 6, 5);
    graphics.fillCircle(center.x - 20, center.y + 8, 4);
    graphics.fillCircle(center.x - 10, center.y + 9, 4);
    graphics.fillCircle(center.x - 16, center.y + 10, 3);

    // LOTS of spikes sticking out of pile
    graphics.fillStyle(isLevel4 ? 0xdaa520 : 0xaaaaaa, alpha);
    // From first ball
    graphics.fillTriangle(center.x - 14, center.y + 1, center.x - 16, center.y + 5, center.x - 12, center.y + 5);
    graphics.fillTriangle(center.x - 10, center.y + 4, center.x - 13, center.y + 7, center.x - 11, center.y + 8);
    graphics.fillTriangle(center.x - 18, center.y + 4, center.x - 15, center.y + 7, center.x - 17, center.y + 8);
    // From second ball
    graphics.fillTriangle(center.x - 20, center.y + 3, center.x - 22, center.y + 7, center.x - 18, center.y + 7);
    graphics.fillTriangle(center.x - 24, center.y + 6, center.x - 21, center.y + 9, center.x - 23, center.y + 10);
    // From third ball
    graphics.fillTriangle(center.x - 6, center.y + 7, center.x - 9, center.y + 10, center.x - 7, center.y + 11);
    graphics.fillTriangle(center.x - 10, center.y + 5, center.x - 12, center.y + 9, center.x - 8, center.y + 9);
    // Highlights
    graphics.fillStyle(isLevel4 ? 0xffd700 : 0xcccccc, alpha * 0.6);
    graphics.fillTriangle(center.x - 13, center.y + 2, center.x - 15, center.y + 4, center.x - 12, center.y + 4);

    // ===== SCATTERED SPIKES ON GROUND =====
    graphics.fillStyle(isLevel4 ? 0xdaa520 : 0x888888, alpha * 0.8);
    // Small spikes scattered around base
    graphics.fillTriangle(center.x + 8, center.y + 10, center.x + 6, center.y + 14, center.x + 10, center.y + 14);
    graphics.fillTriangle(center.x - 4, center.y + 12, center.x - 6, center.y + 16, center.x - 2, center.y + 16);
    graphics.fillTriangle(center.x + 3, center.y + 14, center.x + 1, center.y + 18, center.x + 5, center.y + 18);

    // ===== LOADER PERSON (always visible) =====
    if (showLoader) {
        const lx = center.x + loaderX;
        const ly = center.y + loaderY;

        if (loaderSitting) {
            // SITTING pose (shorter, legs bent) — breathes while idle:
            // chest rises/falls, head + hands ride it with a slight lag
            graphics.fillStyle(0x8b6914, alpha);
            graphics.fillRect(lx - 3, ly - 2 - chestRise, 6, 5 + chestRise);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillCircle(lx + headLook, ly - 5 - headRise, 3);
            graphics.fillStyle(0x654321, alpha);
            graphics.fillRect(lx - 4, ly + 3, 3, 3);
            graphics.fillRect(lx + 1, ly + 3, 3, 3);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillRect(lx - 5, ly - 1 - headRise * 0.7, 2, 3);
            graphics.fillRect(lx + 3, ly - 1 - headRise * 0.7, 2, 3);
        } else if (loaderPulling) {
            // PULLING LEVER pose
            graphics.fillStyle(0x8b6914, alpha);
            graphics.fillRect(lx - 3, ly - 4, 6, 8);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillCircle(lx, ly - 7, 3);
            graphics.fillStyle(0x654321, alpha);
            graphics.fillRect(lx - 3, ly + 4, 2, 5);
            graphics.fillRect(lx + 1, ly + 4, 2, 5);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillRect(lx - 6, ly - 5, 3, 2);
            graphics.fillRect(lx + 3, ly - 5, 3, 2);
            graphics.fillStyle(0x5d4037, alpha);
            graphics.fillRect(lx - 8, ly - 6, 2, 8);
        } else if (loaderCarrying) {
            // CARRYING spike ball — level-dependent colors
            const carryCore = isLevel4 ? 0xeeeedd : (isLevel3 ? 0x333333 : 0x555555);
            const carrySpike = isLevel4 ? 0xdaa520 : (isLevel3 ? 0x888888 : 0xaaaaaa);
            graphics.fillStyle(0x8b6914, alpha);
            graphics.fillRect(lx - 3, ly - 4, 6, 8);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillCircle(lx, ly - 7, 3);
            graphics.fillStyle(0x654321, alpha);
            graphics.fillRect(lx - 3, ly + 4, 2, 5);
            graphics.fillRect(lx + 1, ly + 4, 2, 5);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillRect(lx - 5, ly - 6, 2, 4);
            graphics.fillRect(lx + 3, ly - 6, 2, 4);
            graphics.fillStyle(carryCore, alpha);
            graphics.fillCircle(lx, ly - 12, 3);
            graphics.fillStyle(carrySpike, alpha);
            graphics.fillTriangle(lx, ly - 15, lx - 1, ly - 18, lx + 1, ly - 18);
            graphics.fillTriangle(lx - 3, ly - 12, lx - 6, ly - 13, lx - 6, ly - 11);
            graphics.fillTriangle(lx + 3, ly - 12, lx + 6, ly - 13, lx + 6, ly - 11);
            graphics.fillTriangle(lx, ly - 9, lx - 1, ly - 6, lx + 1, ly - 6);
        } else {
            // STANDING/OPERATING WINCH
            graphics.fillStyle(0x8b6914, alpha);
            graphics.fillRect(lx - 3, ly - 4, 6, 8);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillCircle(lx, ly - 7, 3);
            graphics.fillStyle(0x654321, alpha);
            graphics.fillRect(lx - 3, ly + 4, 2, 5);
            graphics.fillRect(lx + 1, ly + 4, 2, 5);
            graphics.fillStyle(0xdeb887, alpha);
            graphics.fillRect(lx - 5, ly - 2, 2, 4);
            graphics.fillRect(lx + 3, ly - 2, 2, 4);
        }
    }

    // ===== IDLE SPIKE-TIP GLINT (specular sweep across the tips) =====
    // Four sites visited in turn (500 ms each, sine size envelope): loaded
    // ball tip -> ammo pile -> ground spike -> rack. Opaque sparkle colors
    // (steel-white; gold accent at L4); geometry-gated, no faint alpha.
    if (idleGate > 0.01) {
        const gp = ((time % 2000) + 2000) % 2000;
        const gSite = Math.floor(gp / 500);
        const gt = (gp % 500) / 500;
        const gr = Math.sin(gt * Math.PI) * 1.8 * idleGate;
        if (gr > 0.55) {
            const tipUp = isLevel4 ? 13 : isLevel3 ? 11 : 9;
            const gSites = [
                [armTipX, armTipY + slingDrop + 5 - tipUp],
                [center.x - 14, center.y + 1.5],
                [center.x + 8, center.y + 11],
                [center.x + 20, center.y - (isLevel3 ? 8 : 6)],
            ];
            const gx = gSites[gSite][0], gy = gSites[gSite][1];
            graphics.fillStyle(isLevel4 ? 0xffe98c : 0xe9f2f4, alpha);
            graphics.fillCircle(gx, gy, gr);
            if (gr > 1.2) {
                graphics.fillStyle(isLevel4 ? 0xfff6cf : 0xffffff, alpha);
                graphics.fillCircle(gx, gy - 0.4, gr * 0.45);
            }
        }
    }

    // ===== FLYING BALL (during throw animation) — level-dependent =====
    if (showFlyingBall) {
        const bx = center.x + flyingBallX;
        const by = center.y + flyingBallY;
        const flyCore = isLevel4 ? 0xeeeedd : (isLevel3 ? 0x333333 : 0x555555);
        const flySpike = isLevel4 ? 0xdaa520 : (isLevel3 ? 0x888888 : 0xaaaaaa);

        graphics.fillStyle(flyCore, alpha);
        graphics.fillCircle(bx, by, 3);

        graphics.fillStyle(flySpike, alpha);
        graphics.fillTriangle(bx, by - 3, bx - 1, by - 7, bx + 1, by - 7);
        graphics.fillTriangle(bx, by + 3, bx - 1, by + 7, bx + 1, by + 7);
        graphics.fillTriangle(bx - 3, by, bx - 7, by - 1, bx - 7, by + 1);
        graphics.fillTriangle(bx + 3, by, bx + 7, by - 1, bx + 7, by + 1);
    }
}
}
