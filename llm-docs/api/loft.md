---
id: api/loft
title: loft(...profiles)
summary: Builds a smooth solid that blends between two or more profile sketches at different positions.
tags: [api, 3d, solid]
symbols: [loft]
seeAlso: [api/sketch, api/sweep, api/extrude]
---

# loft

Imported from `fluidcad/core`.

```ts
loft(...profiles: SceneObject[])
```

Returns `Loft` (extends `BooleanOperation`). Each profile is typically a
sketch on a different plane (or a face selection). The solid interpolates
between them in order.

Chain: `.thin()`, plus the boolean scope methods. Direct accessors:
`startFaces`, `endFaces`, `sideFaces`, `startEdges`, `endEdges`,
`sideEdges`, `internalFaces`, `internalEdges`, `capFaces`, `capEdges`.

## Example

```fluid.js
import { circle, line, loft, plane, sketch } from "fluidcad/core";

const bottom = sketch("xy", () => circle([0, 0], 40));
const top = sketch(plane("xy", { offset: 100 }), () => {
  line([-30, -30], [30, -30]);
  line([30, -30], [30, 30]);
  line([30, 30], [-30, 30]);
  line([-30, 30], [-30, -30]);
});
loft(bottom, top);
```

See [[api/sweep]] for path-driven solids and [[api/extrude]] for the
straight-pull case.
