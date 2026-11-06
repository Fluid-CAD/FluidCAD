---
id: api/feature-example-tube
title: "Example: a tube whose remove cuts only its bore — getOperationMode() in a custom feature"
summary: "A complete custom feature module and a model: a tube standing on XY that offers add, new and remove, and reads this.getOperationMode() to build a different tool for a remove: added or new, the Ø12 tube; removed, only its Ø8 bore. A hub fuses the tube into a disk, then bores through both and keeps the tube's wall."
tags: [example, sdk, custom-feature]
seeAlso: [api/feature, api/define-feature, api/sdk-kernel]
---

# Example: a tube that cuts only its bore

`this.getOperationMode()` ([[api/feature]]) reads the operation the base
applies to what `buildTool()` returns: the statement's chain, else the
feature's default (`add` here). The tube returns the whole tube for an add
or a new, and only the space inside it for a remove:

```feature.js
// tube.feature.js
// A tube standing on XY: added or new, the tube; removed, only its bore.
import { Feature, defineFeature } from 'fluidcad/sdk';
import { BooleanOps, Primitives } from 'fluidcad/sdk/kernel';

export class Tube extends Feature.with({
  outer: { type: 'length', default: 12, min: 0 },
  bore: { type: 'length', default: 8, min: 0 },
  height: { type: 'length', default: 10, min: 0 },
}) {
  static id = 'tube';

  buildTool() {
    const { outer, bore, height } = this.values;
    const space = Primitives.makeCylinder(bore / 2, height);
    if (this.getOperationMode() === 'remove') {
      return [space];
    }
    const body = Primitives.makeCylinder(outer / 2, height);
    const tube = BooleanOps.cutShapes(body, space);
    body.dispose();
    space.dispose();
    return [tube];
  }
}

export const tube = defineFeature(Tube, {
  label: 'Tube',
  group: 'create',
  operations: ['add', 'new', 'remove'],
  call: [{ outer: 'outer', bore: 'bore', height: 'height' }],
});
```

```fluid.js
import { part, cylinder } from "fluidcad/core";
import { tube } from "./tube.feature.js";

export const hub = part("Hub", () => {
  cylinder(20, 10);
  tube({ height: 25 });            // fuses a Ø12 tube into the Ø40 disk
  tube({ height: 25 }).remove();   // bores Ø8 through both; the tube's wall stays
});
```
