import assert from 'node:assert/strict';
import { BUILDING_DEFINITIONS, type BuildingType } from '../src/game/config/GameDefinitions';
import {
    BUILDING_VISUAL_CATALOG,
    DEDICATED_BUILDING_VISUAL_ROUTES,
    buildingVisualDescriptor
} from '../src/game/renderers/BuildingVisualCatalog';

const definitionTypes = Object.keys(BUILDING_DEFINITIONS).sort() as BuildingType[];
const visualTypes = Object.keys(BUILDING_VISUAL_CATALOG).sort() as BuildingType[];
assert.deepEqual(
    visualTypes,
    definitionTypes,
    'every building definition must declare an explicit visual route'
);

const knownRoutes = new Set<string>(DEDICATED_BUILDING_VISUAL_ROUTES);
const intentionalGeneric: BuildingType[] = [];
for (const type of definitionTypes) {
    const descriptor = buildingVisualDescriptor(type);
    if (descriptor.route === 'generic') {
        assert(descriptor.reason.trim().length > 0, `${type} uses generic art without an explicit reason`);
        intentionalGeneric.push(type);
    } else {
        assert(knownRoutes.has(descriptor.route), `${type} points at unknown visual route ${descriptor.route}`);
    }
}

assert(definitionTypes.length > 0, 'building catalog unexpectedly empty');

console.log(
    `building visual dispatch regression: ${definitionTypes.length} building types covered, `
    + `${intentionalGeneric.length} intentional generic routes`
);
