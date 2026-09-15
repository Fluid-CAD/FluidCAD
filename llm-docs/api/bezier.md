---
id: api/bezier
title: bezier(...points)
summary: Free-form bezier curve. The first point is the explicit start, the last is the endpoint; points in between are control points (degree = args − 1).
tags: [api, 2d, primitive, curve]
symbols: [bezier]
seeAlso: [api/arc, api/line]
---

# bezier

Imported from `fluidcad/core`.

```ts
bezier(...points: Point2D[])
```

The first argument is the explicit start, the last is the endpoint; any
arguments in between are control points.

| Args | Degree   | Shape                                |
|------|----------|--------------------------------------|
| 2    | 1 (line) | straight segment from start to end   |
| 3    | 2        | quadratic bezier (start, ctrl, end)  |
| 4    | 3        | cubic bezier (start, c1, c2, end)    |

## Example

```fluid.js
import { bezier, extrude, line, sketch } from "fluidcad/core";
import { coincident, distance, fix, horizontal, vertical } from "fluidcad/constraints";

sketch("xy", () => {
  const l = line([0, 0], [0, 40]);
  const top = bezier([0, 40], [20, 80], [80, 80], [100, 40]);   // cubic bezier
  const r = line([100, 40], [100, 0]);
  const b = line([100, 0], [0, 0]);
  coincident(l.end(), top.start());
  coincident(top.end(), r.start());
  coincident(r.end(), b.start());
  coincident(b.end(), l.start());
  fix(top.point(1), [20, 80]);       // control points are solver points too
  fix(top.point(2), [80, 80]);
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

See [[api/arc]] for circular curves with exact radii.
