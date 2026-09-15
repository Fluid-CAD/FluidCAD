---
id: api/ellipse
title: ellipse(center, rx, ry)
summary: Draws an ellipse at an explicit center using semi-radii (half-widths) along the sketch plane's X and Y axes.
tags: [api, 2d, primitive]
symbols: [ellipse]
seeAlso: [api/circle, api/sketch]
---

# ellipse

Imported from `fluidcad/core`.

```ts
ellipse(center: Point2D, rx, ry)
```

`rx` and `ry` are **semi-radii** — half-widths along the plane's X and Y
axes. (Compare `circle`, which takes a diameter.) The center is
required and explicit. Returns `ExtrudableGeometry` — a fixed-shape
entity: the semi-radii are literals, but the center is a solver point,
so constrain it (`coincident(e.center(), origin())`, `concentric`,
`distance`) like any other point.

## Example

```fluid.js
import { ellipse, extrude, origin, sketch } from "fluidcad/core";
import { coincident } from "fluidcad/constraints";

sketch("xy", () => {
  const e = ellipse([0, 0], 60, 30);
  coincident(e.center(), origin());   // the center is the ellipse's solver point
});
extrude(8);
```

See [[api/circle]] for the symmetric case.
