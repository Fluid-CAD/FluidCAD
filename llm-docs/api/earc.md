---
id: api/earc
title: eArc(start, end, center, rx, ry, rotation?)
summary: Elliptical arc, an open piece of an ellipse, from a start point to an end point. A solver entity that takes what an ellipse takes (radius with an axis, horizontal/vertical, concentric, tangent, equal) and has start, end and center points like an arc. Sweeps counterclockwise by default; chain .cw() for the other side.
tags: [api, 2d, primitive, curve]
symbols: [eArc]
seeAlso: [api/ellipse, api/arc, api/sketch, api/constraints]
---

# eArc

Imported from `fluidcad/core`.

```ts
eArc(start: Point2D, end: Point2D, center: Point2D, rx, ry)
eArc(start: Point2D, end: Point2D, center: Point2D, rx, ry, rotation)
```

An elliptical arc: an open piece of an ellipse. The first three arguments
read like `arc(start, end, center)`, the last three like
`ellipse(center, rx, ry, rotation)`. `rx` and `ry` are **semi-radii** along
the ellipse's own RX and RY axes; `rotation` (degrees) is the angle of the
RX axis from the plane's X axis, `0` when omitted.

Every literal is a GUESS. A start or end that is not exactly on the ellipse
names the point of the ellipse in its direction from the center, so rounded
coordinates are fine. The arc runs **counterclockwise** from start to end;
chain `.cw()` for the other piece between the same two points.

Returns an elliptical arc entity with seven degrees of freedom: the five of
its ellipse, plus where each end sits along it.

Accessors for constraint targets: `.start()`, `.end()`, `.center()`. They
take every point constraint (`coincident`, `distance`, `fix`, `midpoint`,
`symmetric`, a `horizontal`/`vertical` pair).

The statement itself takes what an ellipse takes: `radius(ea, v, 'x')` /
`radius(ea, v, 'y')` dimension the RX / RY semi-radius, `horizontal(ea)` /
`vertical(ea)` orient the RX axis, `concentric(ea, c)` shares the center,
`tangent(ea, l)` touches a line, circle, arc, ellipse or another elliptical
arc, `coincident(p, ea)` puts a point on its ellipse, `equal(ea, e)` shares
both semi-radii with an ellipse or elliptical arc, and
`symmetric(ea1, ea2, l)` mirrors one onto another. Join it smoothly to a
neighbour with `coincident` on the shared end plus `tangent`.

Refused, with a message: `diameter(ea, v)`, `radius(ea, v)` without an
axis, `distance(p, ea, v)`, `equal` with a circle or arc, `offsetFrom`.

## From a center, semi-axes, rotation and two parameter angles

A drawing file gives an elliptical arc as a center `(cx, cy)`, semi-axes
`rx`, `ry`, a rotation and two parameter angles `t0`, `t1`. The point at
parameter `t` is

```ts
x = cx + rx * cos(t) * cos(rotation) - ry * sin(t) * sin(rotation)
y = cy + rx * cos(t) * sin(rotation) + ry * sin(t) * cos(rotation)
```

Pass the point at `t0` as `start`, the point at `t1` as `end`, and add
`.cw()` when the sweep `t1 - t0` is negative.

## Example: an arched opening

```fluid.js
import { eArc, extrude, line, origin, sketch } from "fluidcad/core";
import { coincident, distance, horizontal, radius, tangent, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const sill = line([0, 0], [60, 0]);
  const right = line([60, 0], [60, 40]);
  const crown = eArc([60, 40], [0, 40], [30, 40], 30, 18);
  const left = line([0, 40], [0, 0]);
  coincident(sill.end(), right.start());
  coincident(right.end(), crown.start());
  coincident(crown.end(), left.start());
  coincident(left.end(), sill.start());
  tangent(right, crown);              // the jambs run into the crown without a corner
  tangent(crown, left);
  horizontal(sill);
  vertical(right);
  vertical(left);
  horizontal(crown);                  // the crown's RX axis along X
  coincident(sill.start(), origin());
  distance(sill.start(), sill.end(), 60);
  distance(right.start(), right.end(), 40);
  radius(crown, 18, 'y');             // the rise; RX follows from the width
});
extrude(8);
```

See [[api/ellipse]] for the closed curve and [[api/arc]] for the circular
arc.
