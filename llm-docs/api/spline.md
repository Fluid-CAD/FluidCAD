---
id: api/spline
title: spline(...points)
summary: Smooth curve THROUGH the given points (a cubic interpolating B-spline). The first point is the start, the last the end; the curve passes through every point in order. Every literal point is a solver point — constrain `.point(i)`.
tags: [api, 2d, primitive, curve]
symbols: [spline]
seeAlso: [api/bezier, api/arc, api/line]
---

# spline

Imported from `fluidcad/core`.

```ts
spline(...points: Point2D[])
```

Draws a smooth curve that passes through every point, in order — a cubic
interpolating B-spline (C2 continuous), parameterized by chord length. The
first argument is the start, the last the end; the points between are
*fit points* the curve goes through, not control points that pull it. Use
a spline to trace an outline, a cam profile or a free-form side where you
know points ON the curve; use [[api/bezier]] when you want to shape the
curve with handles instead.

| Args | Shape                                      |
|------|--------------------------------------------|
| 2    | straight segment from start to end         |
| 3    | quadratic curve through the three points   |
| 4+   | cubic curve through every point            |

Inside a sketch every literal point is a solver point entity: constraints
target `.point(i)` (or `.start()` / `.end()`) and the solve reshapes the
curve. A point given as another entity's accessor (`l.end()`) rides that
entity instead. The curve itself is not a solver entity — `tangent`,
`distance` and the other entity-level constraints do not accept it; pin
its points. Two consecutive points at the same position are an error.

## Example

```fluid.js
import { spline, extrude, line, sketch } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const l = line([0, 0], [0, 40]);
  // The top edge passes through (25, 55) and (70, 60) exactly.
  const top = spline([0, 40], [25, 55], [70, 60], [100, 40]);
  const r = line([100, 40], [100, 0]);
  const b = line([100, 0], [0, 0]);
  coincident(l.end(), top.start());
  coincident(top.end(), r.start());
  coincident(r.end(), b.start());
  coincident(b.end(), l.start());
  fix(top.point(1), [25, 55]);       // fit points are solver points too
  fix(top.point(2), [70, 60]);
  vertical(l);
  vertical(r);
  horizontal(b);
  fix(l.start(), [0, 0]);
  distance(l.start(), l.end(), 40);
  distance(r.start(), r.end(), 40);
  distance(b.start(), b.end(), 100);
});
extrude(4);
```

See [[api/bezier]] for a curve shaped by control points and [[api/arc]]
for circular curves with exact radii.
