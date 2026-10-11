// A deliberate crash, for the engine's crash guard: raw OpenCascade code
// that hands the kernel a pointer to memory that isn't there — what raw code
// that freed, or reused, memory the model still needed ends up doing — and
// the kernel traps ("memory access out of bounds"). The pointer lies past
// the end of any 32-bit wasm heap, so the read traps before it can touch
// anything: the engine stays sound, but it can't know that, so it reports
// itself suspect and the page offers a restart. Never use this in a model.

import { Feature, defineFeature } from 'fluidcad/sdk';
import { getOC } from 'fluidcad/sdk/occt';

export class Dangling extends Feature.with({
  face: { picker: 'face', label: 'On face' },
}) {
  static id = 'dangling';

  buildTool() {
    getOC().OCJS.getStandard_FailureData(0xFFFFFFFD);
    return [];
  }
}

export const dangling = defineFeature(Dangling, {
  label: 'Dangling pointer',
  description: 'Crashes the OpenCascade kernel on purpose, to try the engine\'s crash guard — never use it in a model',
  group: 'create',
  call: ['face'],
});
