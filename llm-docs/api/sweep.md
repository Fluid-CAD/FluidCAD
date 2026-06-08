---
id: api/sweep
title: sweep(path)
summary: Sweeps the active sketch (profile) along a path sketch. The profile is consumed implicitly; the path is passed explicitly.
tags: [api, 3d, solid]
symbols: [sweep]
seeAlso: [api/sketch, api/extrude, api/loft, api/revolve]
---

# sweep

Imported from `fluidcad/core`.

```ts
sweep(path: SceneObject)                              // sweep last sketch along path
sweep(path: SceneObject, target?: SceneObject)
```

Returns `Sweep` (extends `BooleanOperation`). Chain: `.draft()`,
`.endOffset()`, `.drill()`, `.pick()`, `.thin()`, plus boolean scope
methods. Direct accessors mirror `extrude`: `startFaces`, `endFaces`,
`sideFaces`, etc.

The path is typically a reusable sketch (open or closed wire) or an
edge selection. The profile is whatever sketch was last opened — usually
on a plane perpendicular to the path's start tangent.

## Example

```fluid.js
import { arc, circle, line, sketch, sweep } from "fluidcad/core";

const path = sketch("xy", () => {
  line([0, 0], [100, 0]);
  arc([200, 100]).radius(150);
}).reusable();

sketch("yz", () => circle(8));
sweep(path);
```

See [[api/loft]] for blending between distinct profiles and
[[api/revolve]] for axis-driven sweeps.
