---
id: api/circle
title: circle(center, diameter?)
summary: Draws a circle on the active sketch plane. The numeric argument is the diameter, not the radius; the center is a solver guess unless constrained.
tags: [api, 2d, primitive]
symbols: [circle]
seeAlso: [api/sketch, api/ellipse, api/arc, api/constraints]
---

# circle

Imported from `fluidcad/core`.

```ts
circle(center: Point2D, diameter?)      // default diameter 40
```

Returns a solved circle entity. The argument is the **diameter** — not
the radius. Center and size are **guesses**: constrain `.center()`
(e.g. `coincident(c.center(), origin())`) and dimension with
`diameter(c, v)` or `radius(c, v)` to make them exact. Chain `.guide()`
for a construction circle.

## Example

```fluid.js
import { circle, extrude, origin, sketch } from "fluidcad/core";
import { coincident, diameter, distance, horizontal } from "fluidcad/constraints";

sketch("xy", () => {
  const big = circle([2, -1], 50);
  const small = circle([58, 3], 20);
  coincident(big.center(), origin());     // pin the big circle to the origin
  diameter(big, 50);
  diameter(small, 20);
  horizontal(big.center(), small.center());
  distance(big.center(), small.center(), 60);
});
extrude(10);
```

See [[api/ellipse]] for asymmetric diameters, [[api/arc]] for partial
circles, and [[api/constraints]] for the constraint catalog.
