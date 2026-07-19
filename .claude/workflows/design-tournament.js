export const meta = {
  name: 'design-tournament',
  description: 'Clean-room design tournament: N isolated designers per unit produce divergent art variants, live-switchable, showcase-ready',
  whenToUse: 'When the owner asks for a NEW or REDESIGNED building/troop/unit. ALWAYS ask the owner how many variations first (default 3). Args: { units: [{unit, kind: "building"|"troop", brief, levels?, dirs?}], variants?: 3, mode?: "redesign"|"new" }. Bake + Design Lab integration happen AFTER the owner picks from the showcase (see src/game/renderers/redesign/DESIGN_TOURNAMENTS.md).',
  phases: [
    { title: 'Prep', detail: 'visual-info-free contracts; stub old art (redesign) or wire data plumbing (new); registry slots' },
    { title: 'Art', detail: 'N isolated designers per unit, screenshot-iterated' },
    { title: 'Gate', detail: 'tsc + committed assets untouched + slots filled' },
  ],
}

const SCRATCH = '/private/tmp/claude-scratch-design-tournament'
const cfg = typeof args === 'string' ? JSON.parse(args) : (args || {})
const UNITS = cfg.units || []
if (!UNITS.length) throw new Error('design-tournament requires args.units: [{unit, kind, brief}]')
const N = Math.max(2, Math.min(6, cfg.variants || 3))
const MODE = cfg.mode || 'redesign'
const SLOTS = ['A', 'B', 'C', 'D', 'E', 'F'].slice(0, N)

const PREP_SCHEMA = {
  type: 'object', required: ['contracts', 'prepared', 'notes'],
  properties: {
    contracts: { type: 'object', description: 'unit -> contract string (technical facts only, ZERO visual info)' },
    prepared: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}
const ART_SCHEMA = {
  type: 'object', required: ['unit', 'slot', 'design', 'screenshots', 'verification'],
  properties: {
    unit: { type: 'string' }, slot: { type: 'string' },
    design: { type: 'string' }, animation: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    screenshots: { type: 'array', items: { type: 'string' } },
    verification: { type: 'string' },
  },
}

phase('Prep')
const unitList = UNITS.map(u => `${u.unit} (${u.kind})`).join(', ')
const prep = await agent(`You are the CLEAN-ROOM PREP agent in the clash-game repo (find it: the cwd of this session). Units for a ${N}-variant design tournament: ${unitList}. Mode: ${MODE}.

For EACH unit produce a TECHNICAL CONTRACT with ZERO visual information (no colors/shapes/motifs/poses): draw signature(s) + dispatcher wiring; registry stats + one-line mechanical identity; every sim state field the art must read (grep MainScene/DefenseSystem writes); projectile-origin coupling constants if a shooter (artists may NOT edit MainScene); iso/grounding basics; ambient-period rules (idle terms exact harmonics of a 250ms-multiple period, surviving quantization >=1.5 world px or >=16/255 RGB over >=1% texels); required reading list (src/game/renderers/BUILDING_ART_GUIDE.md whole, tools/art-preview/AGENTS_SPRITE_PIPELINE.md, src/game/config/ADDING_BUILDINGS.md or ADDING_TROOPS.md).

MODE '${MODE}': ${MODE === 'redesign'
  ? 'STUB the old art — replace each unit draw fn body with an activeDesign(unit) delegator + neutral placeholder ("// CLEAN-ROOM REDESIGN IN PROGRESS"); signatures unchanged; artists must never see the old bodies.'
  : 'WIRE the data half per src/game/config/ADDING_BUILDINGS.md / ADDING_TROOPS.md: type union, definitions registry entry (stats supplied in the unit brief), visual catalog + dispatcher route, behavior catalog if an active defense, GameTypes state fields — with the draw fn as an activeDesign(unit) delegator + placeholder.'}

Ensure src/game/renderers/redesign/DesignRegistry.ts has ${N} slots per unit with unique anchors ('// IMPORT <unit> <slot>' and '// SLOT <unit> <slot>' for slots ${SLOTS.join('/')}), activeDesign(unit) reading localStorage['clash.design.<unit>'] live. npx tsc --noEmit -p tsconfig.app.json must be clean when done. Return contracts keyed by unit name. Final message goes to the orchestrator.`, { label: 'prep', phase: 'Prep', schema: PREP_SCHEMA })

phase('Art')
log(`Launching ${UNITS.length * N} isolated designers`)
const artists = await parallel(UNITS.flatMap(u => SLOTS.map(slot => () => agent(`You are CLEAN-ROOM DESIGNER ${slot} for the ${u.unit.toUpperCase()} in the clash-game repo. You are ONE OF ${N} mutually-isolated designers for this unit — the owner wants genuinely divergent designs. Commit fully to YOUR strongest concept; never hedge toward a safe middle.

CONTEXT ISOLATION — ABSOLUTE: FORBIDDEN: git log/diff/show on renderer files or sprite dirs; opening public/assets/sprites/** for this unit; opening tools/art-preview/shots/**; reading ANY file in src/game/renderers/redesign/ other than DesignRegistry.ts and your own new file.

REQUIRED READING first: src/game/renderers/BUILDING_ART_GUIDE.md (all), the ambient/bake rules in tools/art-preview/AGENTS_SPRITE_PIPELINE.md, src/game/config/${u.kind === 'troop' ? 'ADDING_TROOPS' : 'ADDING_BUILDINGS'}.md. Iron rules: base/elevated split; contact shadow + compact pad only, NO ground plates; deterministic f(time); idle terms exact harmonics of ONE 250ms-multiple period surviving quantization; max level = warm sandstone + gold/white ACCENTS only; never Math.random per frame.

BRIEF: ${u.brief}

TECHNICAL CONTRACT:
\${PREP_CONTRACT}

MECHANICS: write your whole design in ONE new file src/game/renderers/redesign/${u.unit[0].toUpperCase()}${u.unit.slice(1)}${slot}.ts exporting one draw fn matching the contract signature; register via EXACTLY your two anchor lines in DesignRegistry.ts. Do NOT edit other renderer files, MainScene, bake scripts, or anything under public/assets/. No bakes. tsc clean for your files.

VERIFY WITH SCREENSHOTS (typechecking is not seeing): find the running dev server (probe 127.0.0.1:5173-5176; if none, start one on a free port >=5176). Own headless page (crib setup from tools/art-preview/shoot-defenses.mjs${u.kind === 'troop' ? ' and shoot-troops.mjs' : ''}; shared token tools/art-preview/.shared-device-token.json, NEVER guest sessions) with localStorage['clash.sprites.off']='1' AND localStorage['clash.design.${u.unit}']='${slot}' set before boot. Iterate until you would sign it: every level, day AND night, idle-motion series across your loop period, ${u.kind === 'troop' ? '8+ distinct headings + walk stride + attack sequence' : 'several aim angles (if the unit aims) + full fire/active sequence'}. Vector-mode iteration done, run the OWNER HARD-RULE FINAL PASS — POST-BAKE: scratch-bake your design (cd tools/art-preview && DESIGN=${slot} UNITS=${u.unit} OUT=<your scratch dir>/bake node bake-sprites.mjs — NEVER write public/assets; troops use TROOPS=${u.unit}) and re-screenshot from the BAKED frames (composite the baked atlas or reload with sprites ON pointing at your scratch bake); judge silhouette, ambient legibility and palette AFTER quantization and fix regressions before submitting. Curate 4-6 labeled POST-BAKE finals into ${SCRATCH}/${u.unit}-${slot}/ and LOOK at each with Read before submitting.

Report unit, slot, concept (2-4 sentences), animation notes, files, screenshots, verification. Final message goes to the orchestrator.`.replace('\${PREP_CONTRACT}', (prep.contracts && prep.contracts[u.unit]) || 'CONTRACT MISSING — extract it yourself under the same zero-visual-info rules before designing.'), { label: `art:${u.unit}-${slot}`, phase: 'Art', schema: ART_SCHEMA }))))

phase('Gate')
const gate = await agent(`Light gate in the clash-game repo after a ${UNITS.length * N}-designer tournament that must NOT have touched committed assets: 1) npx tsc --noEmit -p tsconfig.app.json → clean (repair only src/game/renderers/redesign/** and the registry); 2) git status --short public/assets/ → list any modification newer than the tournament window as a violation; 3) all ${UNITS.length * N} registry slots filled (report empties); 4) stub/placeholder delegators still typecheck and default sanely. Report via schema.`, { label: 'gate', phase: 'Gate', schema: {
  type: 'object', required: ['tscClean', 'assetsUntouched', 'slotsFilled', 'notes'],
  properties: { tscClean: { type: 'boolean' }, assetsUntouched: { type: 'boolean' }, slotsFilled: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } } })

return { designs: artists.filter(Boolean), gate, next: 'Build the showcase artifact from the designs’ POST-BAKE screenshots (owner hard rule — never pre-bake vector shots) for the owner to pick; then bake winners (or all variants) under the @slot convention with DESIGN=<slot> and reconcile regression counts — see src/game/renderers/redesign/DESIGN_TOURNAMENTS.md steps 4-5.' }