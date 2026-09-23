// Public surface of the apply-feature router. The server mounts it; sibling routes and tests
// reach the shared validators and limits through here.

export { allocateExposeName } from '../foreign-exposure.ts';
export { MAX_SCOPE_TARGETS } from './locations.ts';
export { validatePick } from './picks.ts';
export { MAX_REGION_KEYS, validateRegionKeys } from './regions.ts';
export { createApplyFeatureRouter, type ApplyFeatureRouterOptions } from './router.ts';
export { makeSynthesisOptionsForFile } from './synthesis.ts';
export { MAX_COPY_TARGETS } from './validate/copy.ts';
export { MAX_MIRROR_TARGETS } from './validate/mirror.ts';
export { MAX_REPEAT_TARGETS } from './validate/repeat.ts';
export { MAX_ROTATE_TARGETS } from './validate/rotate.ts';
