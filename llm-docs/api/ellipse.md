---
id: api/ellipse
title: ellipse(center, rx, ry, rotation?)
summary: Draws an ellipse at an explicit center using semi-radii (half-widths) along its own axes; a solver entity whose center, rotation and radii the constraints drive, like a circle.
tags: [api, 2d, primitive]
symbols: [ellipse]
seeAlso: [api/circle, api/sketch, api/constraints]
---

# ellipse

Imported from `fluidcad/core`.

```ts
ellipse(center: Point2D, rx, ry)
ellipse(center: Point2D, rx, ry, rotation)
```

`rx` and `ry` are **semi-radii** — half-widths along the ellipse's own RX
and RY axes. (Compare `circle`, which takes a diameter.) The center is
required and explicit. `rotation` (degrees) is the angle of the RX axis
from the plane's X axis, `0` when omitted. Every literal is a GUESS, like
a circle's center and diameter.

Returns `ExtrudableGeometry`. The ellipse is a solver entity with five
degrees of freedom. Constrain the statement itself — `radius(e, v, 'x')`
/ `radius(e, v, 'y')` dimension the RX / RY semi-radius, `horizontal(e)`
/ `vertical(e)` orient the RX axis along X / Y, `concentric(e, c)` shares
a center with a circle, arc or ellipse, `tangent(e, l)` touches a line,
circle, arc or another ellipse, `coincident(p, e)` puts a point on the
outline, `equal(e, f)` matches two ellipses' shapes — and its center
through `e.center()` like any other point (`coincident`, `distance`,
`fix`, …). A fully constrained ellipse has its center pinned, its RX axis
oriented and both semi-radii dimensioned. `diameter` refuses an ellipse.

## Example

```fluid.js
import { ellipse, extrude, origin, sketch } from "fluidcad/core";
import { coincident, horizontal, radius } from "fluidcad/constraints";

sketch("xy", () => {
  const e = ellipse([0, 0], 60, 30);
  coincident(e.center(), origin());   // the center is a solver point
  horizontal(e);                      // the RX axis along X: the rotation is pinned
  radius(e, 60, 'x');                 // RX semi-radius
  radius(e, 30, 'y');                 // RY semi-radius — the ellipse is now fully constrained
});
extrude(8);
```

See [[api/circle]] for the symmetric case.
